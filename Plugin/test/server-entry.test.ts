import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { contributeKeypad } from "../index.server";
import { BridgeClient } from "../server/bridge-client";
import { PaseoCli } from "../server/cli";
import { keypadSettings, SettingsSchema } from "../shared/settings";
import type { KeypadStatus } from "../shared/rpc";
import { FakeBridge } from "../scripts/fake-bridge.ts";

type State = PluginSettingsState<typeof keypadSettings.schema>;
type Handler = (input: unknown, context: { paseo: unknown }) => unknown;

const paseo = {
  agents: {
    list: async () => ({
      entries: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      subscription: {
        subscribe: (observer: { snapshot(value: unknown): void }) => {
          observer.snapshot({
            entries: [],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          });
          return () => {};
        },
        release: async () => {},
      },
    }),
  },
  workspaces: {
    list: async () => ({
      entries: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      subscription: {
        subscribe: (observer: { snapshot(value: unknown): void }) => {
          observer.snapshot({
            entries: [],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          });
          return () => {};
        },
        release: async () => {},
      },
    }),
  },
  hosts: { list: async () => ({ self: { serverId: "srv_test" } }) },
};

let directory: string;
let socketPath: string;
let bridge: FakeBridge;
let cleanup: (() => Promise<void>) | null;
let logs: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cm-"));
  socketPath = join(directory, "b.sock");
  bridge = new FakeBridge({ socketPath });
  await bridge.listen();
  cleanup = null;
  logs = [];
});

afterEach(async () => {
  await cleanup?.();
  await bridge.close();
  await rm(directory, { recursive: true, force: true });
});

/** Starts the server entry with settings that `read` supplies, and returns its RPCs. */
function start(read: () => Promise<State>) {
  const listeners: ((state: State) => void)[] = [];
  const handlers = new Map<string, Handler>();
  const server = {
    registerSettings: () => ({
      read,
      subscribe: (listener: (state: State) => void) => {
        listeners.push(listener);
        return () => {};
      },
    }),
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
    on: () => () => {},
  } as unknown as PluginServerContext;
  cleanup = contributeKeypad(server, {
    log: (message) => logs.push(message),
    bridge: new BridgeClient({ socketPath, minBackoffMs: 10, maxBackoffMs: 20 }),
    cli: new PaseoCli({ configuredPath: () => "", resolve: async () => null }),
    renderDelayMs: 1,
  }) as () => Promise<void>;
  return {
    status: () => handlers.get("keypad.status")?.({}, { paseo }) as KeypadStatus,
    notify: (state: State) => {
      for (const listener of listeners) listener(state);
    },
  };
}

const ready = (values: unknown = {}): State => ({
  status: "ready",
  revision: "r1",
  values: SettingsSchema.parse({ connection: { socketPath }, ...(values as object) }),
});

const invalid: State = { status: "invalid", revision: "r1", error: "bindings.ACT06: bad" };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the server entry", () => {
  it("does nothing with the keypad until the settings load", async () => {
    let resolveRead: (state: State) => void = () => {};
    const entry = start(() => new Promise((resolve) => (resolveRead = resolve)));
    await pause(50);
    expect(bridge.clientCount).toBe(0);
    expect(entry.status().settings).toEqual({ status: "loading", error: null });
    resolveRead(ready());
    await bridge.waitForClients();
    expect(entry.status().settings).toEqual({ status: "ready", error: null });
  });

  it("turns actions off and reports the error when the settings cannot be read", async () => {
    const entry = start(async () => {
      throw new Error("EIO: the disk is unhappy");
    });
    await pause(50);
    expect(bridge.clientCount).toBe(0);
    expect(entry.status().settings).toMatchObject({
      status: "error",
      error: expect.stringContaining("EIO") as string,
    });
    expect(logs.some((line) => line.includes("EIO"))).toBe(true);
  });

  it("turns actions off for invalid stored settings instead of using the defaults", async () => {
    const entry = start(async () => invalid);
    await pause(50);
    expect(bridge.clientCount).toBe(0);
    expect(entry.status().settings).toMatchObject({
      status: "error",
      error: expect.stringContaining("bindings.ACT06") as string,
    });
  });

  it("turns actions off while the settings are invalid, and on again when they are fixed", async () => {
    const voice = { bindings: { ACT12: { action: "toggleVoiceMode" } } };
    const entry = start(async () => ready(voice));
    await bridge.waitForClients();
    entry.status();
    await bridge.waitFor((command) => command.type === "setKeyLights");

    entry.notify(invalid);
    bridge.tap(12);
    await pause(50);
    expect(bridge.received.some((command) => command.shortcut === "cmd+shift+d")).toBe(false);
    expect(entry.status().lastAction).toMatchObject({ ok: false, action: "none" });

    entry.notify(ready(voice));
    bridge.tap(12);
    await bridge.waitFor((command) => command.shortcut === "cmd+shift+d");
  });

  it("prefers a change notification over a read that ends later", async () => {
    let resolveRead: (state: State) => void = () => {};
    const entry = start(() => new Promise((resolve) => (resolveRead = resolve)));
    entry.notify(ready());
    resolveRead(invalid);
    await pause(20);
    expect(entry.status().settings.status).toBe("ready");
  });
});
