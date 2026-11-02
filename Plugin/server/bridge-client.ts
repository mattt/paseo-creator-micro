import { createConnection, type Socket } from "node:net";
import {
  BRIDGE_PROTOCOL_VERSION,
  parseAppLine,
  type AppMessage,
  type BridgeCommand,
  type BridgeInput,
  type BridgeKeypadState,
} from "./bridge-protocol";

export type BridgeConnectionState = "stopped" | "connecting" | "connected" | "waiting";

export interface BridgeClientOptions {
  socketPath: string;
  log?: (message: string) => void;
  /** First retry delay. Each failure doubles it up to `maxBackoffMs`. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  /** How long the app has to send its `hello` after the socket opens. */
  helloTimeoutMs?: number;
  /** Most requests that may wait for a result at once; more are refused unsent. */
  maxPendingRequests?: number;
  /** Most bytes that may wait in the socket's write buffer; more are refused unsent. */
  maxBufferedBytes?: number;
  /** Longest accepted line; longer lines are dropped. */
  maxLineLength?: number;
  /** Returns a number in [0, 1) for retry jitter. */
  random?: () => number;
}

export interface BridgeListeners {
  state: (state: BridgeConnectionState) => void;
  hello: (message: Extract<AppMessage, { type: "hello" }>) => void;
  keypad: (keypad: BridgeKeypadState) => void;
  input: (input: BridgeInput) => void;
  /** The socket's write buffer emptied after it was full. */
  drain: () => void;
}

export class BridgeError extends Error {
  override readonly name: string = "BridgeError";
}

/**
 * A request that the app may or may not have carried out:
 * it was written to the socket, but no result confirmed its outcome.
 */
export class BridgeUncertainError extends BridgeError {
  override readonly name = "BridgeUncertainError";
  readonly uncertain = true;
}

export interface BridgeRequestOptions {
  timeoutMs?: number;
  /**
   * Marks other commands as effectful, like openURL and sendShortcut.
   * Cancellation or timeout destroys the connection to discard buffered writes.
   * Without a result, written commands reject with BridgeUncertainError and are never retried.
   */
  resetOnTimeout?: boolean;
  /** Cancels the request; an outstanding effect destroys the connection and is uncertain. */
  signal?: AbortSignal;
}

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  readonly effectful: boolean;
  written: boolean;
}

const DEFAULTS = {
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
  requestTimeoutMs: 5_000,
  helloTimeoutMs: 5_000,
  maxPendingRequests: 16,
  maxBufferedBytes: 64 * 1024,
  maxLineLength: 1 << 20,
} as const;

/**
 * A client of the keypad app's bridge socket.
 *
 * It connects when started, waits for the app's `hello`, and reconnects with
 * exponential backoff when the app is not running, does not say hello in time,
 * or the connection drops. Malformed lines are logged and skipped.
 *
 * It never queues work behind a peer that stops reading: requests beyond
 * `maxPendingRequests` or `maxBufferedBytes` are refused without being sent.
 */
export class BridgeClient {
  private socketPathValue: string;
  private readonly log: (message: string) => void;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxBufferedBytes: number;
  private readonly maxLineLength: number;
  private readonly random: () => number;

  private socket: Socket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private congested = false;
  private failures = 0;
  private buffer = "";
  private discardingLine = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners: { [Name in keyof BridgeListeners]: Set<BridgeListeners[Name]> } = {
    state: new Set(),
    hello: new Set(),
    keypad: new Set(),
    input: new Set(),
    drain: new Set(),
  };

  private stateValue: BridgeConnectionState = "stopped";
  private appVersionValue: string | null = null;
  private keypadValue: BridgeKeypadState | null = null;
  private lastErrorValue: string | null = null;
  private loggedUnavailable = false;

  constructor(options: BridgeClientOptions) {
    this.socketPathValue = options.socketPath;
    this.log = options.log ?? (() => {});
    this.minBackoffMs = options.minBackoffMs ?? DEFAULTS.minBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULTS.maxPendingRequests;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULTS.maxBufferedBytes;
    this.maxLineLength = options.maxLineLength ?? DEFAULTS.maxLineLength;
    this.random = options.random ?? Math.random;
  }

  get state(): BridgeConnectionState {
    return this.stateValue;
  }

  get socketPath(): string {
    return this.socketPathValue;
  }

  /** The app's version from its `hello`, while connected. */
  get appVersion(): string | null {
    return this.appVersionValue;
  }

  /** The last keypad state from the app, while connected. */
  get keypad(): BridgeKeypadState | null {
    return this.keypadValue;
  }

  /** Whether the connection is up and its write buffer is not full. */
  get writable(): boolean {
    return this.stateValue === "connected" && this.socket !== null && !this.congested;
  }

  /** Why the last connection attempt failed or ended, if it did. */
  get lastError(): string | null {
    return this.lastErrorValue;
  }

  on<Name extends keyof BridgeListeners>(name: Name, listener: BridgeListeners[Name]): () => void {
    const set = this.listeners[name] as Set<BridgeListeners[Name]>;
    set.add(listener);
    return () => set.delete(listener);
  }

  start(): void {
    if (this.stateValue !== "stopped") return;
    this.connect();
  }

  async stop(): Promise<void> {
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    if ([...this.pending.values()].some((pending) => pending.effectful && pending.written)) {
      socket?.destroy();
    }
    this.teardown("The bridge client stopped");
    this.setState("stopped");
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 500).unref();
      });
    }
  }

  /**
   * Connects now instead of waiting for the next retry.
   * A connection that is still waiting for the app's hello is replaced.
   */
  retryNow(): void {
    if (this.stateValue !== "waiting" && this.stateValue !== "connecting") return;
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.destroy();
      this.teardown("Reconnecting to the keypad app");
    }
    this.failures = 0;
    this.connect();
  }

  /** Changes the socket path and reconnects if the path differs. */
  setSocketPath(socketPath: string): void {
    if (socketPath === this.socketPathValue) return;
    this.socketPathValue = socketPath;
    if (this.stateValue === "stopped") return;
    this.clearRetry();
    this.socket?.destroy();
    this.socket = null;
    this.teardown("The socket path changed");
    this.failures = 0;
    this.connect();
  }

  /**
   * Sends a command and waits for the app's result.
   * Refuses, without sending, a command that would exceed the request or buffer limits.
   */
  request(command: BridgeCommand, options: BridgeRequestOptions = {}): Promise<void> {
    const socket = this.socket;
    if (this.stateValue !== "connected" || !socket) {
      return Promise.reject(new BridgeError("The keypad app is not connected"));
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason as Error);
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(
        new BridgeError(
          `Too many commands are waiting for the keypad app; did not send ${command.type}`,
        ),
      );
    }
    const id = this.nextId;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    const buffered = socket.writableLength;
    if (buffered > 0 && buffered + Buffer.byteLength(line) > this.maxBufferedBytes) {
      return Promise.reject(
        new BridgeError(`The keypad app is not reading; did not send ${command.type}`),
      );
    }
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    return new Promise<void>((resolve, reject) => {
      const signal = options.signal;
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        if (pending.effectful && pending.written) {
          this.drop(socket, `Cancelled ${command.type}`);
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(signal?.reason as Error);
      };
      const settle =
        <Args extends unknown[]>(finish: (...args: Args) => void) =>
        (...args: Args) => {
          signal?.removeEventListener("abort", onAbort);
          finish(...args);
        };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (!pending.effectful || !pending.written) {
          pending.reject(new BridgeError(`The keypad app did not answer ${command.type}`));
          return;
        }
        pending.reject(
          new BridgeUncertainError(
            `The keypad app did not answer ${command.type} in time, so it may or may not have run. ` +
              "The plugin reset the connection and will not send it again.",
          ),
        );
        this.drop(socket, `The keypad app did not answer ${command.type}`);
      }, options.timeoutMs ?? this.requestTimeoutMs);
      const pending: PendingRequest = {
        resolve: settle(resolve),
        reject: settle(reject),
        timer,
        effectful:
          command.type === "openURL" ||
          command.type === "sendShortcut" ||
          options.resetOnTimeout === true,
        written: false,
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const writable = socket.write(line);
        pending.written = true;
        if (!writable) this.congest(socket);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        pending.reject(new BridgeError(describeError(error)));
        this.drop(socket, describeError(error));
      }
    });
  }

  private connect(): void {
    this.setState("connecting");
    this.buffer = "";
    this.discardingLine = false;
    const socket = createConnection({ path: this.socketPathValue });
    this.socket = socket;
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      this.drop(socket, "The keypad app did not say hello in time");
    }, this.helloTimeoutMs);
    this.helloTimer.unref();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (this.socket === socket) this.receive(chunk);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (this.socket !== socket) return;
      this.lastErrorValue = describeSocketError(error);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.closed();
    });
  }

  /** Ends a connection at once, discarding anything still buffered, and retries later. */
  private drop(socket: Socket, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.lastErrorValue = reason;
    socket.destroy();
    this.closed();
  }

  private closed(): void {
    const wasConnected = this.stateValue === "connected";
    this.teardown(this.lastErrorValue ?? "The keypad app closed the connection");
    if (wasConnected) {
      this.log("Disconnected from the keypad app");
      this.loggedUnavailable = false;
    } else if (!this.loggedUnavailable) {
      this.log(`Waiting for the keypad app: ${this.lastErrorValue ?? "connection closed"}`);
      this.loggedUnavailable = true;
    }
    this.scheduleRetry();
  }

  private congest(socket: Socket): void {
    if (this.congested) return;
    this.congested = true;
    socket.once("drain", () => {
      if (this.socket !== socket) return;
      this.congested = false;
      this.emit("drain");
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.discardingLine) {
        this.discardingLine = false;
      } else if (line.length > this.maxLineLength) {
        this.logLongLine();
      } else {
        this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      if (this.socket === null) return;
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLineLength) {
      this.logLongLine();
      this.buffer = "";
      this.discardingLine = true;
    }
  }

  private logLongLine(): void {
    this.log(`Dropped a bridge line longer than ${this.maxLineLength} characters`);
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    const parsed = parseAppLine(line);
    if (parsed.kind === "malformed") {
      this.log(`Skipped a malformed bridge line (${parsed.reason})`);
      return;
    }
    if (parsed.kind === "ignored") return;
    const message = parsed.message;
    if (this.stateValue !== "connected" && message.type !== "hello") return;
    switch (message.type) {
      case "hello":
        this.handleHello(message);
        return;
      case "keypad":
        this.keypadValue = message.keypad;
        this.emit("keypad", message.keypad);
        return;
      case "input":
        this.emit("input", message.input);
        return;
      case "result": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve();
        else pending.reject(new BridgeError(message.error ?? "The keypad app refused the command"));
        return;
      }
    }
  }

  private handleHello(message: Extract<AppMessage, { type: "hello" }>): void {
    if (message.protocol !== BRIDGE_PROTOCOL_VERSION) {
      this.lastErrorValue = `The keypad app speaks bridge protocol ${message.protocol}; this plugin speaks ${BRIDGE_PROTOCOL_VERSION}`;
      this.log(this.lastErrorValue);
      this.failures = Number.POSITIVE_INFINITY;
      this.socket?.destroy();
      return;
    }
    if (this.stateValue === "connected") {
      this.log("Ignored a second hello from the keypad app");
      return;
    }
    this.clearHelloTimer();
    this.failures = 0;
    this.lastErrorValue = null;
    this.loggedUnavailable = false;
    this.appVersionValue = message.app.version;
    this.keypadValue = message.keypad;
    this.log(`Connected to the keypad app ${message.app.version}`);
    this.setState("connected");
    this.emit("hello", message);
    this.emit("keypad", message.keypad);
  }

  private teardown(reason: string): void {
    this.clearHelloTimer();
    this.congested = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        pending.effectful && pending.written
          ? new BridgeUncertainError(
              `${reason}. The command may or may not have run. The plugin will not send it again.`,
            )
          : new BridgeError(reason),
      );
      this.pending.delete(id);
    }
    this.appVersionValue = null;
    this.keypadValue = null;
    this.buffer = "";
  }

  private scheduleRetry(): void {
    this.setState("waiting");
    const exponent = Math.min(this.failures, 30);
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** exponent);
    const delay = Math.round(base * (0.5 + this.random() * 0.5));
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(state: BridgeConnectionState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.emit("state", state);
  }

  private emit<Name extends keyof BridgeListeners>(
    name: Name,
    ...args: Parameters<BridgeListeners[Name]>
  ): void {
    for (const listener of this.listeners[name]) {
      try {
        (listener as (...values: Parameters<BridgeListeners[Name]>) => void)(...args);
      } catch (error) {
        this.log(`A bridge ${name} listener failed: ${describeError(error)}`);
      }
    }
  }
}

function describeSocketError(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ENOENT":
      return "the keypad app is not running (no bridge socket)";
    case "ECONNREFUSED":
      return "the keypad app is not accepting connections";
    case "EACCES":
      return "no permission to open the bridge socket";
    default:
      return error.message;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
