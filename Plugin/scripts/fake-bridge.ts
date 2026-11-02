/**
 * A fake keypad app for tests and development.
 *
 * It serves the bridge protocol from `server/bridge-protocol.ts` on a Unix domain socket:
 * it greets each client with `hello`, validates every client command,
 * answers commands that carry an `id` with a `result`,
 * and lets the caller send keypad inputs and state changes.
 *
 * It imports nothing from the plugin, so it checks the plugin against the
 * protocol rather than against the plugin's own reading of it.
 *
 * Run it by hand with `npm run fake-bridge -- [--socket <path>]`.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = 1;

export const DEFAULT_SOCKET_PATH = join(
  homedir(),
  "Library/Application Support/PaseoMicro/bridge.sock",
);

export const EFFECTS = [
  "off",
  "solid",
  "snake",
  "rainbow",
  "breathing",
  "gradient",
  "shallowBreathing",
] as const;

export interface FakeKeypadState {
  connected: boolean;
  transport?: string;
  firmware?: string;
  layer?: number;
  battery?: number;
  charging?: boolean;
  /** The layers whose inputs reach the app; layer 4 on the stock keymap. */
  inputLayers?: number[];
  lightsVisible?: boolean;
}

export type FakeInput =
  | { kind: "key"; key: number; code: string; action: "press" | "release" }
  | { kind: "dial"; action: "clockwise" | "counterclockwise" | "press" | "release" }
  | { kind: "joystick"; angle: number; distance: number; sector: number }
  | { kind: "radial"; slot: number };

/** A valid command that a client sent, as received. */
export interface ReceivedCommand {
  type: string;
  id?: number;
  [field: string]: unknown;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
}

export interface FakeBridgeOptions {
  socketPath: string;
  appVersion?: string;
  protocol?: number;
  keypad?: FakeKeypadState;
  /** The workspace ID that `setSelection` stored, which each `hello` returns. */
  selectedWorkspaceId?: string | null;
  /** Decides the result of a valid command. Defaults to success. */
  respond?: (command: ReceivedCommand) => CommandOutcome | null;
  log?: (message: string) => void;
}

export const DEFAULT_KEYPAD: FakeKeypadState = {
  connected: true,
  transport: "USB",
  firmware: "0.6.3",
  layer: 4,
  battery: 64,
  charging: true,
  inputLayers: [4],
  lightsVisible: true,
};

type Waiter = {
  predicate: (command: ReceivedCommand) => boolean;
  resolve: (command: ReceivedCommand) => void;
};

export class FakeBridge {
  readonly socketPath: string;
  /** Every valid command, in the order received. */
  readonly received: ReceivedCommand[] = [];
  /** Every line that failed validation, with the reason. */
  readonly rejected: { line: string; reason: string }[] = [];

  private readonly appVersion: string;
  private readonly protocol: number;
  private keypad: FakeKeypadState;
  /** The workspace ID that the last successful `setSelection` stored, as the app keeps it. */
  selectedWorkspaceId: string | null;
  private readonly respond: (command: ReceivedCommand) => CommandOutcome | null;
  private readonly log: (message: string) => void;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private waiters: Waiter[] = [];
  private connectionWaiters: (() => void)[] = [];

  constructor(options: FakeBridgeOptions) {
    this.socketPath = options.socketPath;
    this.appVersion = options.appVersion ?? "0.1.0";
    this.protocol = options.protocol ?? PROTOCOL_VERSION;
    this.keypad = { ...(options.keypad ?? DEFAULT_KEYPAD) };
    this.selectedWorkspaceId = options.selectedWorkspaceId ?? null;
    this.respond = options.respond ?? (() => ({ ok: true }));
    this.log = options.log ?? (() => {});
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }

  /** Drops every client connection but keeps listening. */
  disconnectClients(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** Resolves when at least `count` clients are connected. */
  waitForClients(count = 1, timeoutMs = 2_000): Promise<void> {
    if (this.sockets.size >= count) return Promise.resolve();
    return withTimeout(
      new Promise<void>((resolve) => {
        const check = () => {
          if (this.sockets.size >= count) resolve();
          else this.connectionWaiters.push(check);
        };
        this.connectionWaiters.push(check);
      }),
      timeoutMs,
      `no client connected to ${this.socketPath}`,
    );
  }

  /** Resolves with the first command, received now or later, that matches. */
  waitFor(
    predicate: (command: ReceivedCommand) => boolean,
    timeoutMs = 2_000,
  ): Promise<ReceivedCommand> {
    const found = this.received.find(predicate);
    if (found) return Promise.resolve(found);
    return withTimeout(
      new Promise<ReceivedCommand>((resolve) => this.waiters.push({ predicate, resolve })),
      timeoutMs,
      "the expected command did not arrive",
    );
  }

  /** Forgets the commands received so far. */
  clearReceived(): void {
    this.received.length = 0;
    this.rejected.length = 0;
  }

  sendInput(input: FakeInput): void {
    this.broadcast({ type: "input", input });
  }

  press(key: number): void {
    this.sendInput({ kind: "key", key, code: keyCode(key), action: "press" });
  }

  release(key: number): void {
    this.sendInput({ kind: "key", key, code: keyCode(key), action: "release" });
  }

  tap(key: number): void {
    this.press(key);
    this.release(key);
  }

  dial(action: "clockwise" | "counterclockwise" | "press" | "release"): void {
    this.sendInput({ kind: "dial", action });
  }

  joystick(angle: number, distance: number, sector: number): void {
    this.sendInput({ kind: "joystick", angle, distance, sector });
  }

  /** Reports that the joystick picked a slot of the radial menu, 0 (up) to 7, clockwise. */
  pickRadial(slot: number): void {
    this.sendInput({ kind: "radial", slot });
  }

  /**
   * Changes the keypad's state. Unless `lightsVisible` is given, it follows the app's rule:
   * the keypad is connected and its layer is one of `inputLayers`.
   */
  setKeypad(keypad: Partial<FakeKeypadState>): void {
    const next = { ...this.keypad, ...keypad };
    if (keypad.lightsVisible === undefined) {
      next.lightsVisible =
        next.connected &&
        next.layer !== undefined &&
        (next.inputLayers ?? [4]).includes(next.layer);
    }
    this.keypad = next;
    this.broadcast({ type: "keypad", keypad: this.keypad });
  }

  /** Sends a line as is, for testing malformed input. */
  sendRaw(line: string): void {
    for (const socket of this.sockets) socket.write(line);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    this.write(socket, {
      type: "hello",
      protocol: this.protocol,
      app: { version: this.appVersion },
      keypad: this.keypad,
      ...(this.selectedWorkspaceId === null
        ? {}
        : { selectedWorkspaceId: this.selectedWorkspaceId }),
    });
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => this.handleLine(socket, line));
    const waiting = this.connectionWaiters;
    this.connectionWaiters = [];
    for (const check of waiting) check();
  }

  private handleLine(socket: Socket, line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.reject(line, "not JSON");
      return;
    }
    const problem = validateCommand(value);
    const id = idOf(value);
    if (problem !== null) {
      this.reject(line, problem);
      if (id !== undefined) this.write(socket, { type: "result", id, ok: false, error: problem });
      return;
    }
    const command = value as ReceivedCommand;
    this.received.push(command);
    this.log(`received ${line}`);
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.predicate(command)) waiter.resolve(command);
      else remaining.push(waiter);
    }
    this.waiters = remaining;
    if (command.type === "getState") this.write(socket, { type: "keypad", keypad: this.keypad });
    const outcome = this.respond(command);
    if (command.type === "setSelection" && outcome?.ok !== false) {
      this.selectedWorkspaceId = command.workspaceId as string | null;
    }
    if (id === undefined || outcome === null) return;
    this.write(
      socket,
      outcome.ok
        ? { type: "result", id, ok: true }
        : { type: "result", id, ok: false, error: outcome.error ?? "failed" },
    );
  }

  private reject(line: string, reason: string): void {
    this.rejected.push({ line, reason });
    this.log(`rejected ${line}: ${reason}`);
  }

  private broadcast(message: object): void {
    for (const socket of this.sockets) this.write(socket, message);
  }

  private write(socket: Socket, message: object): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

function keyCode(key: number): string {
  const padded = String(key).padStart(2, "0");
  return key < 6 || key > 12 ? `AG${padded}` : `ACT${padded}`;
}

function idOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) ? id : undefined;
}

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const MODIFIERS = new Set(["cmd", "shift", "option", "ctrl"]);
const NAMED_KEYS = new Set(["return", "escape", "space", "tab"]);

function isUnit(value: unknown): boolean {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function lightProblem(light: unknown, where: string): string | null {
  if (typeof light !== "object" || light === null) return `${where} is not an object`;
  const { color, effect, brightness, speed } = light as Record<string, unknown>;
  if (typeof color !== "string" || !COLOR.test(color)) return `${where}.color is not #RRGGBB`;
  if (!(EFFECTS as readonly unknown[]).includes(effect)) return `${where}.effect is unknown`;
  if (!isUnit(brightness)) return `${where}.brightness is not in 0...1`;
  if (speed !== undefined && !isUnit(speed)) return `${where}.speed is not in 0...1`;
  return null;
}

function shortcutProblem(shortcut: unknown): string | null {
  if (typeof shortcut !== "string") return "shortcut is not a string";
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  const seen = new Set<string>();
  for (const modifier of parts) {
    if (!MODIFIERS.has(modifier) || seen.has(modifier)) return `bad modifier in ${shortcut}`;
    seen.add(modifier);
  }
  if (/^[a-z0-9[\]]$/.test(key) || NAMED_KEYS.has(key) || /^f([1-9]|1[0-9]|20)$/.test(key)) {
    return null;
  }
  return `bad key in ${shortcut}`;
}

/** Returns why a client command breaks the protocol, or null when it is valid. */
export function validateCommand(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a JSON object";
  }
  const command = value as Record<string, unknown>;
  if (command.id !== undefined && idOf(command) === undefined) return "id is not an integer";
  switch (command.type) {
    case "setKeyLights": {
      if (!Array.isArray(command.lights)) return "lights is not an array";
      for (const [index, light] of command.lights.entries()) {
        const key = (light as { key?: unknown } | null)?.key;
        if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key > 12) {
          return `lights[${index}].key is not 0...12`;
        }
        const problem = lightProblem(light, `lights[${index}]`);
        if (problem) return problem;
      }
      return null;
    }
    case "setZones": {
      if (command.keys === undefined && command.ambient === undefined) return "no zones";
      for (const zone of ["keys", "ambient"] as const) {
        if (command[zone] === undefined) continue;
        const problem = lightProblem(command[zone], zone);
        if (problem) return problem;
      }
      return null;
    }
    case "clearLights":
    case "getState":
    case "clearRadialMenu":
      return null;
    case "setSelection": {
      if (!("workspaceId" in command)) return "workspaceId is missing";
      const id = command.workspaceId;
      if (id === null) return null;
      if (typeof id !== "string" || id === "" || Buffer.byteLength(id) > 256) {
        return "workspaceId is not 1 to 256 bytes or null";
      }
      // oxlint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f]/.test(id)) return "workspaceId has a control character";
      return null;
    }
    case "setRadialMenu": {
      if (!Array.isArray(command.slots) || command.slots.length !== 8) {
        return "slots is not an array of 8";
      }
      for (const [index, value] of command.slots.entries()) {
        const slot = value as Record<string, unknown> | null;
        if (typeof slot?.icon !== "string" || slot.icon === "")
          return `slots[${index}].icon is missing`;
        if (typeof slot.label !== "string" || slot.label.trim() === "" || slot.label.length > 20) {
          return `slots[${index}].label is not 1 to 20 characters`;
        }
        if (
          slot.color !== undefined &&
          (typeof slot.color !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(slot.color))
        ) {
          return `slots[${index}].color is not #RRGGBB`;
        }
        if (typeof slot.enabled !== "boolean") return `slots[${index}].enabled is not a boolean`;
      }
      if (command.target !== null && typeof command.target !== "string") {
        return "target is not a string or null";
      }
      if (command.bundleID !== undefined && typeof command.bundleID !== "string") {
        return "bundleID is not a string";
      }
      return null;
    }
    case "openURL": {
      if (typeof command.url !== "string") return "url is not a string";
      if (!command.url.startsWith("paseo://")) return "only paseo URLs are allowed";
      return null;
    }
    case "sendShortcut": {
      if (typeof command.bundleID !== "string" || command.bundleID === "") {
        return "bundleID is missing";
      }
      if (typeof command.activate !== "boolean") return "activate is not a boolean";
      return shortcutProblem(command.shortcut);
    }
    case "scroll": {
      if (typeof command.bundleID !== "string" || command.bundleID === "") {
        return "bundleID is missing";
      }
      const lines = command.lines;
      const edge = command.edge;
      if ((lines === undefined) === (edge === undefined)) {
        return "a scroll needs exactly one of lines and edge";
      }
      if (edge !== undefined) {
        if (edge !== "top" && edge !== "bottom") return "edge is not top or bottom";
      } else if (typeof lines !== "number" || !Number.isInteger(lines) || lines === 0) {
        return "lines is not a whole number other than 0";
      } else if (Math.abs(lines) > 100) {
        return "lines is beyond 100";
      }
      if (command.activate !== undefined && typeof command.activate !== "boolean") {
        return "activate is not a boolean";
      }
      const fromTop = command.fromTop;
      if (fromTop !== undefined && (typeof fromTop !== "number" || fromTop <= 0 || fromTop >= 1)) {
        return "fromTop is not between 0 and 1";
      }
      return null;
    }
    default:
      return `unknown command type ${JSON.stringify(command.type)}`;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const HELP = `Commands:
  tap <key>          press and release key 0-12, or 15-18 (joystick sectors of a keymap)
  press <key>        press key 0-12 or 15-18
  release <key>      release key 0-12 or 15-18
  cw | ccw           turn the dial one step
  click              press and release the dial
  hold | letgo       press the dial down, or release it; turns in between are held turns
  joy <direction>    push the joystick up, down, left, or right, then let go
  pick <slot>        pick slot 0-7 of the radial menu (0 up, clockwise)
  keypad on|off      report the keypad as connected or disconnected
  layer <n>          report the keypad layer
  raw <line>         send a line as is
  help               show this help
  quit               stop`;

const JOYSTICK: Record<string, number> = { right: 0, up: 0.25, left: 0.5, down: 0.75 };

async function isLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function main(argv: string[]): Promise<void> {
  const index = argv.indexOf("--socket");
  const socketPath = index === -1 ? DEFAULT_SOCKET_PATH : argv[index + 1];
  if (!socketPath) throw new Error("--socket needs a path");
  if (await isLive(socketPath)) {
    throw new Error(`Something already serves ${socketPath}; quit the keypad app first.`);
  }
  const bridge = new FakeBridge({
    socketPath,
    log: (message) => console.log(message),
  });
  await bridge.listen();
  console.log(`Fake keypad app listening on ${socketPath}\n${HELP}`);
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  input.prompt();
  for await (const line of input) {
    const [command, argument = ""] = line.trim().split(/\s+(.*)/s);
    const key = Number(argument);
    switch (command) {
      case "tap":
        bridge.tap(key);
        break;
      case "press":
        bridge.press(key);
        break;
      case "release":
        bridge.release(key);
        break;
      case "cw":
        bridge.dial("clockwise");
        break;
      case "ccw":
        bridge.dial("counterclockwise");
        break;
      case "click":
        bridge.dial("press");
        bridge.dial("release");
        break;
      case "hold":
        bridge.dial("press");
        break;
      case "letgo":
        bridge.dial("release");
        break;
      case "joy": {
        const angle = JOYSTICK[argument];
        if (angle === undefined) {
          console.log("Use up, down, left, or right.");
          break;
        }
        bridge.joystick(angle, 1, Math.round(angle * 8) % 8);
        bridge.joystick(0, 0, -1);
        break;
      }
      case "pick":
        bridge.pickRadial(key);
        break;
      case "keypad":
        bridge.setKeypad({ connected: argument === "on" });
        break;
      case "layer":
        bridge.setKeypad({ layer: key });
        break;
      case "raw":
        bridge.sendRaw(`${argument}\n`);
        break;
      case "quit":
        input.close();
        break;
      case "":
        break;
      default:
        console.log(HELP);
    }
    input.prompt();
  }
  await bridge.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
