import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  BridgeClient,
  BridgeError,
  type BridgeClientOptions,
  type BridgeConnectionState,
} from "../server/bridge-client";
import { KeypadController } from "../server/controller";
import { SettingsSchema } from "../shared/settings";
import type { BridgeInput } from "../server/bridge-protocol";
import { FakeBridge, type CommandOutcome, type ReceivedCommand } from "../scripts/fake-bridge.ts";

let directory: string;
let socketPath: string;
const bridges: FakeBridge[] = [];
const clients: BridgeClient[] = [];
const servers: Server[] = [];
const peerSockets: Socket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cm-"));
  socketPath = join(directory, "b.sock");
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const socket of peerSockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await rm(directory, { recursive: true, force: true });
});

async function startBridge(
  options: {
    protocol?: number;
    respond?: (command: ReceivedCommand) => CommandOutcome | null;
  } = {},
): Promise<FakeBridge> {
  const bridge = new FakeBridge({ socketPath, ...options });
  await bridge.listen();
  bridges.push(bridge);
  return bridge;
}

/** A peer that accepts connections and does only what `accept` does with them. */
async function startRawPeer(accept: (socket: Socket) => void = () => {}): Promise<Socket[]> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    peerSockets.push(socket);
    socket.on("error", () => {});
    accept(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return sockets;
}

const HELLO = `${JSON.stringify({
  type: "hello",
  protocol: 1,
  app: { version: "0.1.0" },
  keypad: { connected: true },
})}\n`;

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startClient(
  logs: string[] = [],
  options: Partial<Omit<BridgeClientOptions, "socketPath" | "log">> = {},
) {
  const client = new BridgeClient({
    socketPath,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    log: (message) => logs.push(message),
    random: () => 0.5,
    ...options,
  });
  clients.push(client);
  client.start();
  return client;
}

function waitForState(
  client: BridgeClient,
  state: BridgeConnectionState,
  timeoutMs = 2_000,
): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`still ${client.state}, not ${state}`)),
      timeoutMs,
    );
    const off = client.on("state", (next) => {
      if (next !== state) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

function nextInputs(client: BridgeClient, count: number): Promise<BridgeInput[]> {
  const inputs: BridgeInput[] = [];
  return new Promise((resolve) => {
    const off = client.on("input", (input) => {
      inputs.push(input);
      if (inputs.length < count) return;
      off();
      resolve(inputs);
    });
  });
}

describe("BridgeClient", () => {
  it("connects and reads the app's hello", async () => {
    await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    expect(client.appVersion).toBe("0.1.0");
    expect(client.keypad).toMatchObject({ connected: true, layer: 4, firmware: "0.6.3" });
  });

  it("delivers key, dial, and joystick inputs", async () => {
    const bridge = await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    const inputs = nextInputs(client, 4);
    bridge.press(3);
    bridge.release(3);
    bridge.dial("counterclockwise");
    bridge.joystick(0.25, 1, 2);
    expect(await inputs).toEqual([
      { kind: "key", key: 3, code: "AG03", action: "press" },
      { kind: "key", key: 3, code: "AG03", action: "release" },
      { kind: "dial", action: "counterclockwise" },
      { kind: "joystick", angle: 0.25, distance: 1, sector: 2 },
    ]);
  });

  it("follows keypad state changes", async () => {
    const bridge = await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    const changed = new Promise((resolve) => client.on("keypad", resolve));
    bridge.setKeypad({ layer: 1 });
    expect(await changed).toMatchObject({ layer: 1 });
    expect(client.keypad?.layer).toBe(1);
  });

  it("sends commands that the protocol accepts and resolves their results", async () => {
    const bridge = await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    await client.request({
      type: "setKeyLights",
      lights: [{ key: 0, color: "#FF2D2D", brightness: 1, effect: "breathing", speed: 0.5 }],
    });
    await client.request({ type: "openURL", url: "paseo://h/srv_1/agent/a1" });
    await client.request({
      type: "sendShortcut",
      bundleID: "sh.paseo.desktop",
      shortcut: "cmd+shift+d",
      activate: true,
    });
    expect(bridge.rejected).toEqual([]);
    expect(bridge.received.map((command) => command.type)).toEqual([
      "setKeyLights",
      "openURL",
      "sendShortcut",
    ]);
    expect(bridge.received.every((command) => typeof command.id === "number")).toBe(true);
  });

  it("rejects a request when the app reports a failure", async () => {
    await startBridge({
      respond: (command) =>
        command.type === "sendShortcut"
          ? { ok: false, error: "Accessibility permission is missing" }
          : { ok: true },
    });
    const client = startClient();
    await waitForState(client, "connected");
    const result = client.request({
      type: "sendShortcut",
      bundleID: "sh.paseo.desktop",
      shortcut: "cmd+d",
      activate: true,
    });
    await expect(result).rejects.toThrow("Accessibility permission is missing");
    await expect(result).rejects.toBeInstanceOf(BridgeError);
  });

  it("times out a request that gets no result", async () => {
    await startBridge({ respond: () => null });
    const client = startClient([], { requestTimeoutMs: 50 });
    await waitForState(client, "connected");
    await expect(client.request({ type: "clearLights" })).rejects.toThrow("did not answer");
  });

  it("rejects requests while disconnected", async () => {
    const client = startClient();
    await expect(client.request({ type: "clearLights" })).rejects.toThrow("not connected");
  });

  it("skips malformed lines and keeps reading", async () => {
    const bridge = await startBridge();
    const logs: string[] = [];
    const client = startClient(logs);
    await waitForState(client, "connected");
    const inputs = nextInputs(client, 1);
    bridge.sendRaw("not json\n");
    bridge.sendRaw("[1,2]\n");
    bridge.sendRaw('{"no":"type"}\n');
    bridge.sendRaw('{"type":"input","input":{"kind":"key","key":99,"action":"press"}}\n');
    bridge.sendRaw('{"type":"somethingNew","value":1}\n');
    bridge.sendRaw('{"type":"input","input":{"kind":"dial",');
    bridge.sendRaw('"action":"clockwise"}}\r\n');
    expect(await inputs).toEqual([{ kind: "dial", action: "clockwise" }]);
    expect(logs.filter((line) => line.startsWith("Skipped a malformed bridge line"))).toHaveLength(
      4,
    );
    expect(client.state).toBe("connected");
  });

  it("drops a line that is too long", async () => {
    const bridge = await startBridge();
    const logs: string[] = [];
    const client = new BridgeClient({ socketPath, maxLineLength: 256, log: (m) => logs.push(m) });
    clients.push(client);
    client.start();
    await waitForState(client, "connected");
    const inputs = nextInputs(client, 1);
    bridge.sendRaw(`{"type":"input","pad":"${"x".repeat(300)}`);
    bridge.sendRaw(`${"y".repeat(300)}"}\n`);
    bridge.dial("press");
    expect(await inputs).toEqual([{ kind: "dial", action: "press" }]);
    expect(logs.some((line) => line.includes("longer than 256"))).toBe(true);
  });

  it("waits for the app and connects when it starts", async () => {
    const logs: string[] = [];
    const client = startClient(logs);
    await waitForState(client, "waiting");
    expect(client.lastError).toContain("not running");
    await startBridge();
    await waitForState(client, "connected");
    expect(logs.filter((line) => line.startsWith("Waiting for the keypad app"))).toHaveLength(1);
  });

  it("reconnects after the app drops the connection", async () => {
    const bridge = await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    const pending = client.request({ type: "getState" }, { timeoutMs: 5_000 });
    bridge.disconnectClients();
    await expect(pending).rejects.toBeInstanceOf(BridgeError);
    await waitForState(client, "waiting");
    await waitForState(client, "connected");
  });

  it("reconnects after the app quits and starts again", async () => {
    const first = await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    await first.close();
    bridges.splice(bridges.indexOf(first), 1);
    await waitForState(client, "waiting");
    expect(client.keypad).toBeNull();
    await startBridge();
    await waitForState(client, "connected");
    expect(client.keypad?.connected).toBe(true);
  });

  it("refuses an app that speaks another protocol version", async () => {
    await startBridge({ protocol: 2 });
    const logs: string[] = [];
    const client = startClient(logs);
    await waitForState(client, "waiting");
    expect(client.lastError).toContain("protocol 2");
    expect(logs.some((line) => line.includes("protocol 2"))).toBe(true);
  });

  it("stops and stays stopped", async () => {
    const bridge = await startBridge();
    const client = startClient();
    await waitForState(client, "connected");
    await client.stop();
    expect(client.state).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.state).toBe("stopped");
    expect(bridge.clientCount).toBe(0);
  });

  it("gives up on an app that never says hello, and retries", async () => {
    const sockets = await startRawPeer();
    const logs: string[] = [];
    const client = startClient(logs, { helloTimeoutMs: 50 });
    await waitForState(client, "waiting");
    expect(client.lastError).toContain("hello");
    await until(() => sockets.length >= 2);
    expect(sockets[0]?.destroyed || sockets[0]?.readableEnded).toBe(true);
  });

  it("replaces a stalled connection when asked to reconnect", async () => {
    const sockets = await startRawPeer();
    const client = startClient([], { helloTimeoutMs: 60_000 });
    await until(() => sockets.length === 1);
    expect(client.state).toBe("connecting");
    client.retryNow();
    await until(() => sockets.length === 2);
    expect(client.state).toBe("connecting");
    await until(() => sockets[0]?.readableEnded === true || sockets[0]?.destroyed === true);
  });

  it("refuses more requests than it lets wait for results", async () => {
    const bridge = await startBridge({ respond: () => null });
    const client = startClient([], { maxPendingRequests: 2 });
    await waitForState(client, "connected");
    const first = client.request({ type: "getState" });
    const second = client.request({ type: "getState" });
    first.catch(() => {});
    second.catch(() => {});
    await expect(client.request({ type: "clearLights" })).rejects.toThrow("Too many");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bridge.received.map((command) => command.type)).toEqual(["getState", "getState"]);
  });

  it("stops writing to an app that does not read", async () => {
    await startRawPeer((socket) => {
      socket.write(HELLO);
      socket.pause();
    });
    const client = startClient([], { maxBufferedBytes: 64 * 1024 });
    await waitForState(client, "connected");
    const large = client.request(
      { type: "openURL", url: `paseo://h/srv/agent/${"x".repeat(512 * 1024)}` },
      { timeoutMs: 60_000 },
    );
    large.catch(() => {});
    expect(client.writable).toBe(false);
    await expect(client.request({ type: "openURL", url: "paseo://h/srv/agent/a" })).rejects.toThrow(
      "not reading",
    );
  });

  it.each(["openURL", "sendShortcut"] as const)(
    "reports a written %s as uncertain on connection loss",
    async (type) => {
      const bridge = await startBridge({ respond: () => null });
      const client = startClient();
      await waitForState(client, "connected");
      const command =
        type === "openURL"
          ? { type, url: "paseo://h/srv/agent/a" }
          : { type, bundleID: "sh.paseo.desktop", shortcut: "cmd+d", activate: true };
      const pending = client.request(command).catch((error: unknown) => error);
      await bridge.waitFor((received) => received.type === type);
      bridge.disconnectClients();
      expect(await pending).toMatchObject({ uncertain: true });
    },
  );

  it("keeps a read-only connection failure certain", async () => {
    const bridge = await startBridge({ respond: () => null });
    const client = startClient();
    await waitForState(client, "connected");
    const pending = client.request({ type: "getState" }).catch((error: unknown) => error);
    await bridge.waitFor((command) => command.type === "getState");
    bridge.disconnectClients();
    expect(await pending).not.toHaveProperty("uncertain");
  });

  it("discards a buffered action before controller cleanup can flush it", async () => {
    const sockets = await startRawPeer((socket) => {
      socket.write(HELLO);
      socket.pause();
    });
    const client = startClient([], { minBackoffMs: 60_000 });
    const controller = new KeypadController({ bridge: client, log: () => {} });
    controller.applySettings(
      SettingsSchema.parse({
        connection: { socketPath, paseoBundleId: "x".repeat(8 * 1024 * 1024) },
      }),
    );
    controller.start();
    await waitForState(client, "connected");
    const peer = sockets[0]!;
    peer.write(
      `${JSON.stringify({ type: "input", input: { kind: "key", key: 11, action: "press" } })}\n`,
    );
    await until(() => !client.writable);
    const stopping = controller.stop();
    // Abort must destroy the connection synchronously, before cleanup sends clearLights.
    const disconnectedOnAbort = client.state !== "connected";
    let received = "";
    peer.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    peer.resume();
    await stopping;
    await until(() => peer.readableEnded || peer.destroyed);
    expect(disconnectedOnAbort).toBe(true);
    expect(received).not.toContain("\n");
    expect(received).not.toContain("clearLights");
    expect(controller.status().lastAction).toMatchObject({ ok: false, uncertain: true });
  });

  it("resets the connection when an action times out, and never sends it again", async () => {
    const bridge = await startBridge({
      respond: (command) => (command.type === "openURL" ? null : { ok: true }),
    });
    const logs: string[] = [];
    const client = startClient(logs);
    await waitForState(client, "connected");
    const action = client.request(
      { type: "openURL", url: "paseo://h/srv/agent/a" },
      { timeoutMs: 50, resetOnTimeout: true },
    );
    await expect(action).rejects.toMatchObject({ uncertain: true });
    await expect(action).rejects.toThrow("may or may not");
    await waitForState(client, "connected");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.received.filter((command) => command.type === "openURL")).toHaveLength(1);
    expect(logs).toContain("Disconnected from the keypad app");
  });
});
