import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BridgeClient } from "../server/bridge-client";
import { PaseoCli, type ExecFileFunction } from "../server/cli";
import {
  agentLink,
  KeypadController,
  MAX_QUEUED_ACTIONS,
  resolveSocketPath,
} from "../server/controller";
import type { PaseoApi } from "../server/paseo-session";
import { SettingsSchema } from "../shared/settings";
import { FakeBridge, type CommandOutcome, type ReceivedCommand } from "../scripts/fake-bridge.ts";
import { CLAUDE_MODELS } from "./fixtures";

/** An agent snapshot; by default the agent is alone in a workspace with the same ID. */
function snapshot(id: string, overrides: Record<string, unknown> = {}): AgentSnapshotPayload {
  return {
    id,
    workspaceId: id,
    provider: "claude",
    cwd: "/tmp/project",
    model: "claude-opus-5-5",
    thinkingOptionId: "medium",
    status: "idle",
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    lastUserMessageAt: null,
    pendingPermissions: [],
    title: `Agent ${id}`,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    ...overrides,
  } as unknown as AgentSnapshotPayload;
}

function workspaceSnapshot(
  id: string,
  overrides: Record<string, unknown> = {},
): WorkspaceDescriptorPayload {
  return {
    id,
    projectId: "p",
    projectDisplayName: "project",
    projectRootPath: "/tmp/project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title: null,
    archivingAt: null,
    status: "done",
    statusEnteredAt: null,
    activityAt: "2026-10-26T10:00:00.000Z",
    ...overrides,
  } as unknown as WorkspaceDescriptorPayload;
}

/** An agent with an unread finished turn, so that its workspace key is green. */
const UNREAD = {
  lastUserMessageAt: "2026-10-26T10:00:00.000Z",
  requiresAttention: true,
  attentionReason: "finished",
  attentionTimestamp: "2026-10-26T10:05:00.000Z",
};

type Observer = { update(message: unknown): void; snapshot(value: unknown): void };

/**
 * A daemon with agents and workspaces. Unless `workspaces` is given,
 * it has one workspace for each workspace ID of the initial agents.
 */
function fakePaseo(
  initial: AgentSnapshotPayload[],
  options: {
    modelsGate?: Promise<void>;
    /** The provider's models; by default, Opus 5.5 with low, medium, and high. */
    models?: readonly unknown[];
    pageSize?: number;
    beforePage?: () => Promise<void> | void;
    workspaces?: WorkspaceDescriptorPayload[];
  } = {},
) {
  const observers: Observer[] = [];
  const workspaceObservers: Observer[] = [];
  const calls: string[] = [];
  const workspaceIds = [
    ...new Set(initial.map((agent) => agent.workspaceId).filter((id) => id !== undefined)),
  ];
  const workspaces = options.workspaces ?? workspaceIds.map((id) => workspaceSnapshot(id));
  const page = (cursor = "0") => {
    const start = Number(cursor);
    const end = start + (options.pageSize ?? initial.length);
    return {
      entries: initial.slice(start, end).map((agent) => ({ agent })),
      pageInfo: {
        nextCursor: end < initial.length ? String(end) : null,
        prevCursor: null,
        hasMore: end < initial.length,
      },
    };
  };
  const api = {
    agents: {
      list: async (request: { page?: { cursor?: string }; subscribe?: object }) => {
        if (request.page?.cursor) await options.beforePage?.();
        const result = page(request.page?.cursor);
        return {
          ...result,
          subscription: {
            subscribe(observer: Observer) {
              observers.push(observer);
              observer.snapshot(result);
              return () => {};
            },
            release: async () => {
              calls.push("release");
            },
          },
        };
      },
      ref: (id: string) => ({
        respondToPermission: async ({
          requestId,
          response,
        }: {
          requestId: string;
          response: { behavior: string };
        }) => void calls.push(`${response.behavior} ${id} ${requestId}`),
        send: async (text: string, options: { activeTurnBehavior?: string }) =>
          void calls.push(`send ${id} ${text} ${options.activeTurnBehavior}`),
      }),
    },
    workspaces: {
      list: async () => {
        const result = {
          entries: workspaces,
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        };
        return {
          ...result,
          subscription: {
            subscribe(observer: Observer) {
              workspaceObservers.push(observer);
              observer.snapshot(result);
              return () => {};
            },
            release: async () => {},
          },
        };
      },
    },
    hosts: { list: async () => ({ self: { serverId: "srv_test", label: "Mac" }, hosts: [] }) },
    providers: {
      listModels: async () => {
        calls.push("listModels");
        await options.modelsGate;
        return {
          provider: "claude",
          models: options.models ?? [
            {
              provider: "claude",
              id: "claude-opus-5-5",
              label: "Opus",
              thinkingOptions: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        };
      },
    },
  };
  return {
    paseo: api as unknown as PaseoApi,
    calls,
    refresh(next: AgentSnapshotPayload[]) {
      initial = next;
      for (const observer of observers) observer.snapshot(page());
    },
    upsert(agent: AgentSnapshotPayload) {
      for (const observer of observers) {
        observer.update({ type: "agent_update", payload: { kind: "upsert", agent } });
      }
    },
    upsertWorkspace(workspace: WorkspaceDescriptorPayload) {
      for (const observer of workspaceObservers) {
        observer.update({ type: "workspace_update", payload: { kind: "upsert", workspace } });
      }
    },
    removeWorkspace(id: string) {
      for (const observer of workspaceObservers) {
        observer.update({ type: "workspace_update", payload: { kind: "remove", id } });
      }
    },
  };
}

let directory: string;
let socketPath: string;
let bridge: FakeBridge;
let controller: KeypadController;
let cliCalls: string[];
let cliSignals: (AbortSignal | undefined)[];
let cliGate: Promise<void> | null;
let sleepGate: Promise<void> | null;
let sleeping: boolean;
let respond: (command: ReceivedCommand) => CommandOutcome | null;

const defaultRespond = (command: ReceivedCommand): CommandOutcome | null =>
  command.type === "sendShortcut" && command.shortcut === "cmd+shift+d"
    ? { ok: false, error: "Accessibility permission is missing" }
    : { ok: true };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cm-"));
  socketPath = join(directory, "b.sock");
  respond = defaultRespond;
  bridge = new FakeBridge({ socketPath, respond: (command) => respond(command) });
  await bridge.listen();
  cliCalls = [];
  cliSignals = [];
  cliGate = null;
  sleepGate = null;
  sleeping = false;
  const exec: ExecFileFunction = async (_file, args, options) => {
    cliCalls.push(args.join(" "));
    cliSignals.push(options.signal);
    const gate = cliGate;
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason as Error));
      });
    }
    return { stdout: "", stderr: "" };
  };
  controller = new KeypadController({
    log: () => {},
    bridge: new BridgeClient({
      socketPath,
      minBackoffMs: 10,
      maxBackoffMs: 20,
      requestTimeoutMs: 200,
    }),
    cli: new PaseoCli({ configuredPath: () => "", exec, resolve: async () => "/bin/paseo" }),
    renderDelayMs: 1,
    meterMs: 150,
    failureMs: 100,
    sleep: async () => {
      sleeping = true;
      await sleepGate;
    },
  });
  controller.applySettings(testSettings());
  controller.start();
});

afterEach(async () => {
  await controller.stop();
  await bridge.close();
  await rm(directory, { recursive: true, force: true });
});

/**
 * The settings of most tests: workspaces on the top keys, keys 8–10 approve, deny, and stop,
 * key 12 toggles voice mode, the dial selects and opens workspaces, the joystick changes thinking
 * (up and down) and selects workspaces (left and right), and no keys share a keycap,
 * so that the tests do not depend on the default layout.
 */
function testSettings(
  overrides: Record<string, unknown> & { bindings?: Record<string, unknown> } = {},
) {
  return SettingsSchema.parse({
    connection: { socketPath },
    topKeys: { mode: "workspaces" },
    keyGroups: [],
    radialMenu: { enabled: false },
    ...overrides,
    bindings: {
      ACT07: { action: "approvePermission" },
      ACT08: { action: "denyPermission" },
      ACT09: { action: "stopAgent" },
      ACT11: { action: "toggleVoiceMode" },
      dialClockwise: { action: "selectNextWorkspace" },
      dialCounterclockwise: { action: "selectPreviousWorkspace" },
      dialPress: { action: "openSelectedWorkspace" },
      joystickUp: { action: "thinkingUp" },
      joystickDown: { action: "thinkingDown" },
      joystickLeft: { action: "selectPreviousWorkspace" },
      joystickRight: { action: "selectNextWorkspace" },
      ...overrides.bindings,
    },
  });
}

/** The default settings with the test socket and the given changes. */
const layoutDefaults = (overrides: Record<string, unknown> = {}) =>
  SettingsSchema.parse({ connection: { socketPath }, ...overrides });

/**
 * The default settings with the test socket, the given changes, and workspaces on the top keys,
 * so that tests can select workspaces with them.
 */
const withDefaults = (overrides: Record<string, unknown> = {}) =>
  layoutDefaults({ topKeys: { mode: "workspaces" }, ...overrides });

/** The default settings, with the test socket and workspaces on the top keys. */
const defaultSettings = () => withDefaults();

/** The default settings with thinking on the held dial, as settings version 6 had it. */
const heldDialThinking = () =>
  withDefaults({
    bindings: {
      dialHeldClockwise: { action: "thinkingUp" },
      dialHeldCounterclockwise: { action: "thinkingDown" },
    },
  });

const lightsOf = (command: ReceivedCommand) =>
  command.lights as { key: number; color: string; brightness: number; effect: string }[];

async function latestKeyLights(predicate: (command: ReceivedCommand) => boolean = () => true) {
  return bridge.waitFor((command) => command.type === "setKeyLights" && predicate(command));
}

async function connected(paseo: PaseoApi) {
  await bridge.waitForClients();
  controller.attachPaseo(paseo);
  await latestKeyLights();
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the condition did not become true");
    await pause(5);
  }
}

/** Makes CLI commands wait until the returned function runs. */
function holdCli(): () => void {
  let release = () => {};
  cliGate = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

/** Selects workspace `a` on key 0 and starts `paseo stop a`, which waits until released. */
async function blockOnStop(): Promise<() => void> {
  const release = holdCli();
  bridge.tap(0);
  bridge.press(9);
  await until(() => cliCalls.includes("stop a"));
  return release;
}

const shortcuts = (shortcut: string) =>
  bridge.received.filter((command) => command.shortcut === shortcut).length;

async function reconnected(): Promise<void> {
  await until(() => controller.status().bridge.state !== "connected");
  await until(() => controller.status().bridge.state === "connected");
}

describe("KeypadController", () => {
  it("sends no lights before it has the Paseo connection", async () => {
    await bridge.waitForClients();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.received).toEqual([]);
    expect(controller.status().paseoAttached).toBe(false);
  });

  it("lights the workspace keys and zones once attached", async () => {
    const fake = fakePaseo([
      snapshot("a", { status: "running", updatedAt: "2026-10-26T12:00:00.000Z" }),
      snapshot("b", { requiresAttention: true, attentionReason: "finished" }),
    ]);
    await connected(fake.paseo);
    const keys = lightsOf(await latestKeyLights());
    expect(keys.map((light) => light.color).slice(0, 3)).toEqual(["#2D7BFF", "#2DFF6A", "#000000"]);
    // Key 6 and the underglow show the next agent that needs action: b's unread result.
    expect(keys[6]).toMatchObject({ key: 6, color: "#2DFF6A" });
    const zones = await bridge.waitFor((command) => command.type === "setZones");
    expect(zones.ambient).toMatchObject({ color: "#2DFF6A", effect: "solid" });
    expect(bridge.rejected).toEqual([]);
    expect(
      controller
        .status()
        .keys.slice(0, 2)
        .map((key) => key.workspaceId),
    ).toEqual(["a", "b"]);
  });

  it("shows one color for a workspace with several agents, and the underglow for any agent with that source", async () => {
    controller.applySettings(testSettings({ lights: { underglowSource: "anyNeedsInput" } }));
    const fake = fakePaseo(
      [
        snapshot("busy", { workspaceId: "w1", status: "running" }),
        snapshot("broken", { workspaceId: "w1", status: "error" }),
        snapshot("asking", {
          workspaceId: "w1",
          pendingPermissions: [{ id: "r1", kind: "tool" }],
        }),
        snapshot("finished", {
          workspaceId: "w2",
          requiresAttention: true,
          attentionReason: "finished",
        }),
        snapshot("working", { workspaceId: "w2", status: "running" }),
      ],
      {
        workspaces: [
          workspaceSnapshot("w1", { activityAt: "2026-10-26T12:00:00.000Z" }),
          workspaceSnapshot("w2", { activityAt: "2026-10-26T11:00:00.000Z" }),
          workspaceSnapshot("empty", { activityAt: "2026-10-26T09:00:00.000Z" }),
          workspaceSnapshot("hidden", { background: true }),
        ],
      },
    );
    await connected(fake.paseo);
    const keys = lightsOf(
      await latestKeyLights((command) => lightsOf(command)[0]?.color === "#FF2D2D"),
    );
    expect(keys.slice(0, 4).map((light) => light.color)).toEqual([
      "#FF2D2D",
      "#2D7BFF",
      "#000000",
      "#000000",
    ]);
    const status = controller.status();
    expect(status.keys.map((key) => key.workspaceId)).toEqual([
      "w1",
      "w2",
      "empty",
      null,
      null,
      null,
    ]);
    expect(status.keys.map((key) => key.state).slice(0, 3)).toEqual(["failed", "running", "idle"]);
    expect(status.keys[0]).toMatchObject({ agentCount: 3, project: "project", title: "w1" });
    const ambientEffect = (command: ReceivedCommand) =>
      (command.ambient as { effect: string } | undefined)?.effect;
    const zones = await bridge.waitFor(
      (command) => command.type === "setZones" && ambientEffect(command) !== "off",
    );
    expect(zones.ambient).toMatchObject({ color: "#FFD000", effect: "breathing" });
    expect(status.ambient).toMatchObject({ color: "#FFD000" });

    fake.upsert(snapshot("asking", { workspaceId: "w1" }));
    await bridge.waitFor(
      (command) => command.type === "setZones" && ambientEffect(command) === "off",
    );
  });

  it("lights key 6 and the underglow with the next agent that needs action, and follows each press", async () => {
    const fake = fakePaseo([
      snapshot("old", {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: "2026-10-26T10:00:00.000Z",
      }),
      snapshot("new", {
        pendingPermissions: [{ id: "r1", kind: "tool" }],
        requiresAttention: true,
        attentionReason: "permission",
        attentionTimestamp: "2026-10-26T11:00:00.000Z",
      }),
      snapshot("sub", {
        status: "error",
        labels: { "paseo.parent-agent-id": "old" },
      }),
    ]);
    const key6 = (command: ReceivedCommand) => lightsOf(command).find((light) => light.key === 6);
    const ambient = (command: ReceivedCommand) =>
      command.ambient as { color: string; effect: string } | undefined;
    await connected(fake.paseo);
    // The longest waiting agent, old, has an unread result: green. The failed subagent is skipped.
    await latestKeyLights((command) => key6(command)?.color === "#2DFF6A");
    await bridge.waitFor(
      (command) => command.type === "setZones" && ambient(command)?.color === "#2DFF6A",
    );
    expect(controller.status().nextAgent).toMatchObject({ id: "old", state: "done" });
    expect(controller.status().actionKeys).toEqual([
      expect.objectContaining({ key: 6, source: "nextActionableAgent", state: "done" }),
    ]);

    // A press opens old, so the next agent is new, which needs input: yellow.
    bridge.clearReceived();
    bridge.tap(6);
    await bridge.waitFor((command) => command.type === "openURL");
    await latestKeyLights((command) => key6(command)?.color === "#FFD000");
    await bridge.waitFor(
      (command) => command.type === "setZones" && ambient(command)?.color === "#FFD000",
    );
    expect(controller.status().nextAgent).toMatchObject({ id: "new", state: "needsInput" });

    // When no agent needs action any more, key 6 and the underglow turn off.
    bridge.clearReceived();
    fake.upsert(snapshot("old"));
    fake.upsert(snapshot("new"));
    await latestKeyLights((command) => key6(command)?.effect === "off");
    await bridge.waitFor(
      (command) => command.type === "setZones" && ambient(command)?.effect === "off",
    );
    expect(controller.status().nextAgent).toBeNull();
    expect(controller.status().actionKeys[0]?.light.effect).toBe("off");

    // A failure makes the key red again at once.
    bridge.clearReceived();
    fake.upsert(snapshot("new", { status: "error" }));
    await latestKeyLights((command) => key6(command)?.color === "#FF2D2D");
  });

  it("clears the lights when a key loses its light source, so that it shows the key backlight", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    await latestKeyLights((command) => lightsOf(command).some((light) => light.key === 6));
    bridge.clearReceived();
    controller.applySettings(testSettings({ lights: { actionKeys: { ACT06: "none" } } }));
    await bridge.waitFor((command) => command.type === "clearLights");
    const keys = lightsOf(await latestKeyLights());
    expect(keys.map((light) => light.key)).toEqual([0, 1, 2, 3, 4, 5]);
    await bridge.waitFor((command) => command.type === "setZones");
    expect(controller.status().actionKeys).toEqual([]);
  });

  it("opens the pressed workspace's agent that needs input", async () => {
    const fake = fakePaseo(
      [
        snapshot("recent", { workspaceId: "w1", updatedAt: "2026-10-26T12:00:00.000Z" }),
        snapshot("asking", {
          workspaceId: "w1",
          pendingPermissions: [{ id: "r1", kind: "tool" }],
        }),
      ],
      { workspaces: [workspaceSnapshot("w1")] },
    );
    await connected(fake.paseo);
    bridge.tap(0);
    const open = await bridge.waitFor((command) => command.type === "openURL");
    expect(open.url).toBe(agentLink("srv_test", "asking"));
    expect(controller.status().selectedWorkspaceId).toBe("w1");
  });

  it("selects workspaces with the dial and opens the selected one on a dial press", async () => {
    await connected(fakePaseo([snapshot("a", UNREAD), snapshot("b", UNREAD)]).paseo);
    bridge.dial("clockwise");
    bridge.dial("clockwise");
    await until(() => controller.status().selectedWorkspaceId === "b");
    const keys = lightsOf(
      await latestKeyLights((command) => lightsOf(command)[1]?.brightness === 0.6),
    );
    expect(keys[0]?.brightness).toBe(0.3);
    bridge.dial("counterclockwise");
    await until(() => controller.status().selectedWorkspaceId === "a");
    bridge.dial("press");
    bridge.dial("release");
    const open = await bridge.waitFor((command) => command.type === "openURL");
    expect(open.url).toBe(agentLink("srv_test", "a"));
  });

  it("frees the key of an archived workspace and fills it with the next one", async () => {
    const fake = fakePaseo([snapshot("a"), snapshot("b")]);
    await connected(fake.paseo);
    bridge.tap(1);
    await until(() => controller.status().selectedWorkspaceId === "b");
    const onKeys = () =>
      controller
        .status()
        .keys.slice(0, 2)
        .map((key) => key.workspaceId);
    controller.forgetWorkspace("b");
    expect(onKeys()).toEqual(["a", null]);
    expect(controller.status().selectedWorkspaceId).toBeNull();
    fake.upsertWorkspace(workspaceSnapshot("c"));
    expect(onKeys()).toEqual(["a", "c"]);
    fake.removeWorkspace("a");
    expect(onKeys()).toEqual([null, "c"]);
  });

  it("keeps a pinned workspace on its key", async () => {
    controller.applySettings(testSettings({ pins: [null, null, null, null, null, "b"] }));
    await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
    const keys = controller.status().keys;
    expect(keys.map((key) => key.workspaceId)).toEqual(["a", null, null, null, null, "b"]);
    expect(keys[5]?.pinned).toBe(true);
  });

  it("changes nothing in Paseo without an input", async () => {
    const fake = fakePaseo([snapshot("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] })]);
    await connected(fake.paseo);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.calls).toEqual([]);
    expect(cliCalls).toEqual([]);
    expect(
      bridge.received.every((command) =>
        ["setKeyLights", "setZones", "clearRadialMenu"].includes(command.type),
      ),
    ).toBe(true);
  });

  it("sends no prompt from key 13 by default", async () => {
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.tap(0);
    bridge.tap(12);
    await pause(30);
    await controller.idle();
    expect(fake.calls).toEqual([]);
  });

  it("counts each agent that needs attention once", async () => {
    await connected(
      fakePaseo([
        snapshot("a", {
          requiresAttention: true,
          attentionReason: "permission",
          pendingPermissions: [{ id: "r1", kind: "tool" }],
        }),
        snapshot("b", { pendingPermissions: [{ id: "r2", kind: "tool" }] }),
        snapshot("c"),
      ]).paseo,
    );
    expect(controller.status()).toMatchObject({ attentionCount: 2, pendingPermissionCount: 2 });
  });

  it("follows agent updates", async () => {
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.clearReceived();
    fake.upsert(snapshot("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] }));
    const keys = lightsOf(await latestKeyLights());
    expect(keys[0]).toMatchObject({ color: "#FFD000", effect: "breathing" });
  });

  it.each(["delayed", "failed"] as const)(
    "keeps selection and slots during a %s directory refresh",
    async (mode) => {
      let gate: Promise<void> | undefined;
      let finish = () => {};
      let fail = false;
      const fake = fakePaseo(
        ["a", "b", "c", "d", "e", "f", "g"].map((id) => snapshot(id)),
        {
          pageSize: 2,
          beforePage: async () => {
            await gate;
            if (fail) throw new Error("page unavailable");
          },
        },
      );
      await connected(fake.paseo);
      bridge.tap(0);
      await until(() => controller.status().selectedWorkspaceId === "a");
      await controller.idle();
      const slots = controller.status().keys.map((key) => key.workspaceId);
      gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      fail = mode === "failed";
      const next = ["g", "b", "c", "d", "e", "f", "a"].map((id) => snapshot(id));
      fake.refresh(next);
      if (fail) finish();
      await pause(20);
      expect(controller.status().selectedWorkspaceId).toBe("a");
      expect(controller.status().keys.map((key) => key.workspaceId)).toEqual(slots);
      finish();
      fail = false;
      if (mode === "failed") fake.refresh(next);
      await pause(20);
      expect(controller.status().selectedWorkspaceId).toBe("a");
      expect(controller.status().keys.map((key) => key.workspaceId)).toEqual(slots);
    },
  );

  it("opens a workspace key's agent and brightens its key", async () => {
    const fake = fakePaseo([snapshot("a", UNREAD), snapshot("b", UNREAD)]);
    await connected(fake.paseo);
    bridge.clearReceived();
    bridge.tap(1);
    const open = await bridge.waitFor((command) => command.type === "openURL");
    const workspaceOnKey1 = controller.status().keys[1]?.workspaceId ?? "";
    expect(open.url).toBe(agentLink("srv_test", workspaceOnKey1));
    const keys = lightsOf(await latestKeyLights());
    expect(keys[1]?.brightness).toBe(0.6);
    expect(controller.status().selectedWorkspaceId).toBe(workspaceOnKey1);
  });

  it("approves the pending request on press only", async () => {
    const fake = fakePaseo([snapshot("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] })]);
    await connected(fake.paseo);
    bridge.press(7);
    bridge.release(7);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.idle();
    expect(fake.calls).toEqual(["allow a r1"]);
  });

  it("sends Cmd+D to Paseo on push-to-talk press and release", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.press(10);
    bridge.release(10);
    await bridge.waitFor(
      (command) =>
        command.type === "sendShortcut" &&
        bridge.received.filter((c) => c.type === "sendShortcut").length === 2,
    );
    const shortcuts = bridge.received.filter((command) => command.type === "sendShortcut");
    expect(shortcuts).toMatchObject([
      { bundleID: "sh.paseo.desktop", shortcut: "cmd+d", activate: true },
      { bundleID: "sh.paseo.desktop", shortcut: "cmd+d", activate: true },
    ]);
  });

  it("reports a failed action", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.press(11);
    await bridge.waitFor((command) => command.shortcut === "cmd+shift+d");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.idle();
    expect(controller.status().lastAction).toMatchObject({
      action: "toggleVoiceMode",
      ok: false,
      message: "Accessibility permission is missing",
    });
  });

  it("changes thinking through the CLI and stops through the CLI", async () => {
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.tap(0);
    bridge.joystick(0.25, 1, 2);
    bridge.joystick(0, 0, -1);
    bridge.press(9);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.idle();
    expect(cliCalls).toEqual(["agent update a --thinking high", "stop a"]);
  });

  it("clears the lights when it stops", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    await controller.stop();
    expect(bridge.received.at(-1)?.type).toBe("clearLights");
  });
});

describe("KeypadController default layout", () => {
  beforeEach(() => controller.applySettings(defaultSettings()));

  const waiting = (id: string, since: string) =>
    snapshot(id, {
      pendingPermissions: [{ id: `r-${id}`, kind: "tool" }],
      attentionTimestamp: since,
    });
  const opened = () =>
    bridge.received.filter((command) => command.type === "openURL").map((command) => command.url);

  it("opens the agents that need action in turn from key 7, and then starts over", async () => {
    await connected(
      fakePaseo([
        snapshot("idle"),
        waiting("later", "2026-10-26T11:00:00.000Z"),
        snapshot("failed", { status: "error", updatedAt: "2026-10-26T10:45:00.000Z" }),
        snapshot("unread", {
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-10-26T10:15:00.000Z",
        }),
      ]).paseo,
    );
    for (let press = 1; press <= 4; press += 1) {
      bridge.tap(6);
      await until(() => opened().length === press);
    }
    expect(opened()).toEqual(
      ["unread", "failed", "later", "unread"].map((id) => agentLink("srv_test", id)),
    );
    expect(controller.status().selectedWorkspaceId).toBe("unread");
  });

  it("reports that no agent needs action and opens nothing", async () => {
    await connected(fakePaseo([snapshot("idle")]).paseo);
    bridge.tap(6);
    await until(() => controller.status().lastAction !== null);
    expect(controller.status().lastAction).toMatchObject({
      action: "nextActionableAgent",
      ok: true,
      message: "No agent needs action",
    });
    expect(opened()).toEqual([]);
  });

  it("leaves subagents out of key 7, the lights, and the counts unless the settings include them", async () => {
    const parent = { labels: { "paseo.parent-agent-id": "orchestrator" } };
    await connected(
      fakePaseo([
        snapshot("asking", { ...waiting("asking", "2026-10-26T10:15:00.000Z"), ...parent }),
        snapshot("busy", { ...parent, status: "running" }),
      ]).paseo,
    );
    bridge.tap(6);
    await until(() => controller.status().lastAction !== null);
    expect(controller.status().lastAction).toMatchObject({ message: "No agent needs action" });
    expect(opened()).toEqual([]);
    const status = controller.status();
    const stateOf = (id: string) => status.keys.find((key) => key.workspaceId === id)?.state;
    expect([stateOf("asking"), stateOf("busy")]).toEqual(["idle", "running"]);
    expect(status).toMatchObject({ attentionCount: 0, pendingPermissionCount: 0 });
    expect(status.ambient).toMatchObject({ effect: "off" });

    controller.applySettings(withDefaults({ agents: { includeSubagents: true } }));
    expect(controller.status()).toMatchObject({ attentionCount: 1, pendingPermissionCount: 1 });
    bridge.tap(6);
    await until(() => opened().length === 1);
    expect(opened()).toEqual([agentLink("srv_test", "asking")]);
  });

  it("opens the waiting agents of stuck workspaces in turn when key 7 is bound to them", async () => {
    controller.applySettings(
      SettingsSchema.parse({
        connection: { socketPath },
        bindings: { ACT06: { action: "nextStuckWorkspace" } },
      }),
    );
    await connected(
      fakePaseo([
        snapshot("idle"),
        waiting("later", "2026-10-26T11:00:00.000Z"),
        waiting("earlier", "2026-10-26T10:30:00.000Z"),
      ]).paseo,
    );
    bridge.tap(6);
    await until(() => opened().length === 1);
    bridge.tap(6);
    await until(() => opened().length === 2);
    expect(opened()).toEqual([agentLink("srv_test", "earlier"), agentLink("srv_test", "later")]);
    expect(controller.status().selectedWorkspaceId).toBe("later");
  });

  it("reports that no workspace needs input and opens nothing", async () => {
    controller.applySettings(
      SettingsSchema.parse({
        connection: { socketPath },
        bindings: { ACT06: { action: "nextStuckWorkspace" } },
      }),
    );
    await connected(fakePaseo([snapshot("idle")]).paseo);
    bridge.tap(6);
    await until(() => controller.status().lastAction !== null);
    expect(controller.status().lastAction).toMatchObject({
      action: "nextStuckWorkspace",
      ok: true,
      message: "No workspace needs input",
    });
    expect(opened()).toEqual([]);
  });

  it("goes back and forward from top keys 0 and 1 through the agents that the keypad opened", async () => {
    controller.applySettings(layoutDefaults());
    await connected(
      fakePaseo([
        waiting("a", "2026-10-26T10:00:00.000Z"),
        waiting("b", "2026-10-26T10:10:00.000Z"),
        waiting("c", "2026-10-26T10:20:00.000Z"),
      ]).paseo,
    );
    for (let press = 1; press <= 3; press += 1) {
      bridge.tap(6);
      await until(() => opened().length === press);
    }
    bridge.tap(0);
    await until(() => opened().length === 4);
    bridge.tap(0);
    await until(() => opened().length === 5);
    bridge.tap(1);
    await until(() => opened().length === 6);
    expect(opened().slice(3)).toEqual(["b", "a", "b"].map((id) => agentLink("srv_test", id)));
    expect(controller.status().selectedWorkspaceId).toBe("b");
  });

  it("sends Paseo's previous and next workspace shortcuts from top keys 3 and 4", async () => {
    controller.applySettings(layoutDefaults());
    await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
    bridge.tap(3);
    bridge.tap(4);
    await until(() => shortcuts("cmd+]") === 1);
    const sent = bridge.received.filter((command) => command.type === "sendShortcut");
    expect(sent.map((command) => [command.shortcut, command.bundleID])).toEqual([
      ["cmd+[", "sh.paseo.desktop"],
      ["cmd+]", "sh.paseo.desktop"],
    ]);
  });

  it("does nothing from a navigation key that cannot act", async () => {
    controller.applySettings(layoutDefaults());
    await connected(fakePaseo([snapshot("a")]).paseo);
    for (const key of [0, 1, 2, 3, 4, 5]) bridge.tap(key);
    await until(() => controller.status().lastAction?.action === "nextProject");
    await controller.idle();
    expect(controller.status().lastAction).toMatchObject({
      ok: true,
      message: "There is no other project",
    });
    expect(bridge.received.filter((command) => command.type === "sendShortcut")).toEqual([]);
    expect(opened()).toEqual([]);
  });

  it("opens the most recently active workspace's agent in the next and previous project from top keys 5 and 2", async () => {
    controller.applySettings(layoutDefaults());
    const project = (id: string, name: string, activityAt: string) =>
      workspaceSnapshot(id, { projectId: name, projectDisplayName: name, activityAt });
    await connected(
      fakePaseo([snapshot("a1"), snapshot("a2"), snapshot("b1"), snapshot("c1")], {
        workspaces: [
          project("a1", "alpha", "2026-10-26T10:00:00.000Z"),
          project("a2", "alpha", "2026-10-26T11:00:00.000Z"),
          project("b1", "beta", "2026-10-26T10:00:00.000Z"),
          project("c1", "gamma", "2026-10-26T10:00:00.000Z"),
        ],
      }).paseo,
    );
    // Without a current project, next goes to the first project by name.
    bridge.tap(5);
    await until(() => opened().length === 1);
    bridge.tap(5);
    await until(() => opened().length === 2);
    bridge.tap(2);
    await until(() => opened().length === 3);
    bridge.tap(2);
    await until(() => opened().length === 4);
    expect(opened()).toEqual(["a2", "b1", "a2", "c1"].map((id) => agentLink("srv_test", id)));
    expect(controller.status().selectedWorkspaceId).toBe("c1");
  });

  it("lights each navigation key dim white while it can act, and off when it cannot", async () => {
    controller.applySettings(layoutDefaults());
    await connected(
      fakePaseo([
        waiting("a", "2026-10-26T10:00:00.000Z"),
        waiting("b", "2026-10-26T10:10:00.000Z"),
      ]).paseo,
    );
    const lit = () => controller.status().keys.map((key) => key.light.effect !== "off");
    expect(controller.status().topKeyMode).toBe("navigation");
    expect(controller.status().keys.map((key) => key.action)).toEqual([
      "navigateBack",
      "navigateForward",
      "previousProject",
      "previousWorkspace",
      "nextWorkspace",
      "nextProject",
    ]);
    // Two workspaces in one project: only the workspace keys can act.
    expect(lit()).toEqual([false, false, false, true, true, false]);
    expect(controller.status().keys[3]?.light).toEqual({
      color: "#FFFFFF",
      effect: "solid",
      brightness: 0.15,
    });
    bridge.tap(6);
    await until(() => opened().length === 1);
    bridge.tap(6);
    await until(() => opened().length === 2);
    await until(() => lit()[0] === true);
    expect(lit()).toEqual([true, false, false, true, true, false]);
    bridge.tap(0);
    await until(() => lit()[1] === true);
    expect(lit()).toEqual([false, true, false, true, true, false]);
    const keys = lightsOf(
      await latestKeyLights((command) => lightsOf(command)[1]?.effect === "solid"),
    );
    expect(keys.slice(0, 6).map((light) => light.effect)).toEqual([
      "off",
      "solid",
      "off",
      "solid",
      "solid",
      "off",
    ]);
  });

  it("submits from key 13, starts a new agent from key 9, and toggles voice mode from no key", async () => {
    controller.applySettings(layoutDefaults());
    await connected(fakePaseo([]).paseo);
    bridge.tap(12);
    await until(() => shortcuts("return") === 1);
    for (const key of [6, 7, 8, 9, 10, 11]) bridge.tap(key);
    bridge.dial("clockwise");
    bridge.dial("press");
    bridge.dial("release");
    await until(() => shortcuts("cmd+o") === 1);
    await pause(30);
    await controller.idle();
    expect(shortcuts("cmd+shift+d")).toBe(0);
    const sent = bridge.received.filter((command) => command.type === "sendShortcut");
    expect(sent[0]).toMatchObject({
      bundleID: "sh.paseo.desktop",
      shortcut: "return",
      activate: true,
    });
  });

  it("approves and denies from keys 7 and 8", async () => {
    controller.applySettings(layoutDefaults());
    const fake = fakePaseo([
      snapshot("a", {
        pendingPermissions: [
          { id: "r1", kind: "tool" },
          { id: "r2", kind: "tool" },
        ],
      }),
    ]);
    await connected(fake.paseo);
    bridge.tap(7);
    await until(() => fake.calls.includes("allow a r1"));
    fake.refresh([snapshot("a", { pendingPermissions: [{ id: "r2", kind: "tool" }] })]);
    await until(() => controller.status().pendingPermissionCount === 1);
    bridge.tap(8);
    await until(() => fake.calls.includes("deny a r2"));
  });

  it("stops held push to talk before it submits, so the dictated text is sent", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.press(10);
    bridge.tap(12);
    await until(() => shortcuts("return") === 1);
    bridge.release(10);
    await pause(30);
    await controller.idle();
    const sent = bridge.received.filter((command) => command.type === "sendShortcut");
    expect(sent.map((command) => command.shortcut)).toEqual(["cmd+d", "cmd+d", "return"]);
    expect(controller.status().lastAction).toMatchObject({
      action: "submit",
      message: "Stopped dictation and sent it",
    });
  });
});

describe("KeypadController top-key modes", () => {
  const opened = () =>
    bridge.received.filter((command) => command.type === "openURL").map((command) => command.url);
  const recent = (id: string, minute: number, overrides: Record<string, unknown> = {}) =>
    snapshot(id, {
      workspaceId: "w",
      updatedAt: `2026-10-26T10:${String(minute).padStart(2, "0")}:00.000Z`,
      ...overrides,
    });
  const oneWorkspace = { workspaces: [workspaceSnapshot("w")] };

  it("puts the six most recently active agents on stable keys, in the colors of their states", async () => {
    controller.applySettings(withDefaults({ topKeys: { mode: "recentAgents" } }));
    const fake = fakePaseo(
      [
        recent("a", 1),
        recent("b", 2, { status: "running" }),
        recent("c", 3, { status: "error" }),
        recent("d", 4),
        recent("e", 5),
        recent("f", 6),
        recent("old", 0),
        recent("sub", 7, { labels: { "paseo.parent-agent-id": "a" } }),
      ],
      oneWorkspace,
    );
    await connected(fake.paseo);
    const onKeys = () => controller.status().keys.map((key) => key.agentId);
    expect(onKeys()).toEqual(["f", "e", "d", "c", "b", "a"]);
    expect(controller.status().keys.map((key) => key.state)).toEqual([
      "idle",
      "idle",
      "idle",
      "failed",
      "running",
      "idle",
    ]);
    expect(controller.status().keys[3]).toMatchObject({ kind: "agent", title: "Agent c" });
    const keys = lightsOf(await latestKeyLights());
    expect(keys[3]).toMatchObject({ color: "#FF2D2D" });
    expect(keys[4]).toMatchObject({ color: "#2D7BFF" });
    // A newly active agent takes the key of the agent that leaves the six; the others stay.
    fake.upsert(recent("old", 8));
    await until(() => onKeys().includes("old"));
    expect(onKeys()).toEqual(["f", "e", "d", "c", "b", "old"]);
  });

  it("selects an agent on a tap of its key and opens it on a double tap", async () => {
    controller.applySettings(withDefaults({ topKeys: { mode: "recentAgents" } }));
    await connected(fakePaseo([recent("a", 1), recent("b", 2)], oneWorkspace).paseo);
    bridge.tap(1);
    await until(() => controller.status().lastAction !== null);
    expect(controller.status().lastAction).toMatchObject({
      message: "Selected Agent a; tap its key again to open it",
    });
    expect(controller.status().selectedWorkspaceId).toBe("w");
    expect(controller.status().radialMenu.target).toBe("Agent a");
    expect(
      controller
        .status()
        .keys.map((key) => key.selected)
        .slice(0, 2),
    ).toEqual([false, true]);
    expect(opened()).toEqual([]);
    bridge.tap(1);
    await until(() => opened().length === 1);
    expect(opened()).toEqual([agentLink("srv_test", "a")]);
    // A third tap starts a new pair: it selects again without opening.
    bridge.tap(1);
    await pause(30);
    await controller.idle();
    expect(opened()).toHaveLength(1);
    // A tap on another key selects its agent, which the agent actions then use.
    bridge.tap(0);
    await until(() => controller.status().radialMenu.target === "Agent b");
    expect(opened()).toHaveLength(1);
  });

  it("opens an agent on a single tap with that option", async () => {
    controller.applySettings(
      withDefaults({ topKeys: { mode: "recentAgents", openOnSingleTap: true } }),
    );
    await connected(fakePaseo([recent("a", 1), recent("b", 2)], oneWorkspace).paseo);
    bridge.tap(0);
    await until(() => opened().length === 1);
    bridge.tap(1);
    await until(() => opened().length === 2);
    expect(opened()).toEqual(["b", "a"].map((id) => agentLink("srv_test", id)));
  });

  it("shows and opens only the pinned workspaces in the pinned mode", async () => {
    controller.applySettings(
      withDefaults({ topKeys: { mode: "pinned" }, pins: [null, null, "b", null, null, null] }),
    );
    await connected(fakePaseo([snapshot("a", UNREAD), snapshot("b", UNREAD)]).paseo);
    expect(controller.status().keys.map((key) => key.workspaceId)).toEqual([
      null,
      null,
      "b",
      null,
      null,
      null,
    ]);
    const keys = lightsOf(await latestKeyLights());
    expect(keys.slice(0, 6).map((light) => light.effect)).toEqual([
      "off",
      "off",
      "solid",
      "off",
      "off",
      "off",
    ]);
    bridge.tap(0);
    bridge.tap(2);
    await until(() => opened().length === 1);
    await pause(20);
    expect(opened()).toEqual([agentLink("srv_test", "b")]);
  });

  it("keeps every top key dark and idle in the off mode", async () => {
    controller.applySettings(withDefaults({ topKeys: { mode: "off" } }));
    await connected(fakePaseo([snapshot("a", UNREAD)]).paseo);
    const keys = lightsOf(await latestKeyLights());
    expect(keys.slice(0, 6).every((light) => light.effect === "off")).toBe(true);
    expect(controller.status().keys.every((key) => key.kind === "off")).toBe(true);
    bridge.tap(0);
    await pause(30);
    expect(opened()).toEqual([]);
    expect(controller.status().selectedWorkspaceId).toBeNull();
  });
});

describe("KeypadController selection across reloads", () => {
  /** Stops the controller and starts another on the same bridge, as a plugin reload does. */
  async function reload(paseo: PaseoApi) {
    await controller.stop();
    controller = new KeypadController({
      log: () => {},
      bridge: new BridgeClient({ socketPath, minBackoffMs: 10, maxBackoffMs: 20 }),
      renderDelayMs: 1,
    });
    controller.applySettings(testSettings());
    controller.start();
    await connected(paseo);
  }

  const selections = () =>
    bridge.received
      .filter((command) => command.type === "setSelection")
      .map((command) => command.workspaceId);

  it("stores each selection in the app and restores it after a reload", async () => {
    const fake = fakePaseo([snapshot("a"), snapshot("b")]);
    await connected(fake.paseo);
    expect(selections()).toEqual([]);
    bridge.tap(1);
    await until(() => bridge.selectedWorkspaceId === "b");
    bridge.dial("counterclockwise");
    await until(() => bridge.selectedWorkspaceId === "a");
    expect(selections()).toEqual(["b", "a"]);

    bridge.clearReceived();
    await reload(fake.paseo);
    await until(() => controller.status().selectedWorkspaceId === "a");
    await pause(20);
    // The app already holds the restored selection, so nothing goes out.
    expect(selections()).toEqual([]);
  });

  it("drops a stored selection whose workspace is gone, and clears it in the app", async () => {
    const fake = fakePaseo([snapshot("a")]);
    bridge.selectedWorkspaceId = "gone";
    bridge.disconnectClients();
    await connected(fake.paseo);
    await until(() => bridge.selectedWorkspaceId === null);
    expect(controller.status().selectedWorkspaceId).toBeNull();
    expect(selections()).toEqual([null]);
  });

  it("does not restore an archived workspace", async () => {
    const fake = fakePaseo([snapshot("a")], {
      workspaces: [workspaceSnapshot("a", { archivingAt: "2026-10-26T10:00:00.000Z" })],
    });
    bridge.selectedWorkspaceId = "a";
    bridge.disconnectClients();
    await connected(fake.paseo);
    await until(() => bridge.selectedWorkspaceId === null);
    expect(controller.status().selectedWorkspaceId).toBeNull();
  });

  it("keeps a selection made before the restore, and sends its own to an app that restarted", async () => {
    const fake = fakePaseo([snapshot("a"), snapshot("b")]);
    await connected(fake.paseo);
    bridge.tap(0);
    await until(() => bridge.selectedWorkspaceId === "a");
    // The app restarted and lost the selection; the plugin still has it.
    bridge.selectedWorkspaceId = null;
    bridge.clearReceived();
    bridge.disconnectClients();
    await until(() => bridge.selectedWorkspaceId === "a");
    expect(selections()).toEqual(["a"]);
    expect(controller.status().selectedWorkspaceId).toBe("a");

    // Another app state names b, but the plugin's selection wins.
    bridge.selectedWorkspaceId = "b";
    bridge.disconnectClients();
    await until(() => bridge.selectedWorkspaceId === "a");
    expect(controller.status().selectedWorkspaceId).toBe("a");
  });

  it("restores the selection only after the workspaces load", async () => {
    const fake = fakePaseo([snapshot("a"), snapshot("b")]);
    await connected(fake.paseo);
    bridge.tap(1);
    await until(() => bridge.selectedWorkspaceId === "b");
    await controller.stop();
    controller = new KeypadController({
      log: () => {},
      bridge: new BridgeClient({ socketPath, minBackoffMs: 10, maxBackoffMs: 20 }),
      renderDelayMs: 1,
    });
    controller.applySettings(testSettings());
    controller.start();
    await bridge.waitForClients();
    await pause(20);
    // Without Paseo, the plugin knows no workspaces: it neither restores nor clears.
    expect(controller.status().selectedWorkspaceId).toBeNull();
    expect(bridge.selectedWorkspaceId).toBe("b");
    controller.attachPaseo(fake.paseo);
    await until(() => controller.status().selectedWorkspaceId === "b");
  });

  it("logs and goes on when the app lacks the command", async () => {
    respond = (command) =>
      command.type === "setSelection"
        ? { ok: false, error: 'Unknown command type "setSelection"' }
        : { ok: true };
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.tap(0);
    await bridge.waitFor((command) => command.type === "openURL");
    await until(() => selections().length === 1);
    expect(controller.status().selectedWorkspaceId).toBe("a");
    expect(bridge.selectedWorkspaceId).toBeNull();
  });
});

describe("KeypadController dial and joystick", () => {
  beforeEach(() => controller.applySettings(defaultSettings()));

  const scrolls = () => bridge.received.filter((command) => command.type === "scroll");

  it("scrolls Paseo's conversation when the dial turns, down for clockwise", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    bridge.dial("clockwise");
    await until(() => scrolls().length === 1);
    bridge.dial("counterclockwise");
    await until(() => scrolls().length === 2);
    await controller.idle();
    expect(scrolls()).toEqual([
      {
        type: "scroll",
        id: expect.any(Number),
        bundleID: "sh.paseo.desktop",
        lines: 3,
        activate: true,
        fromTop: 0.4,
      },
      {
        type: "scroll",
        id: expect.any(Number),
        bundleID: "sh.paseo.desktop",
        lines: -3,
        activate: true,
        fromTop: 0.4,
      },
    ]);
    expect(controller.status().lastAction).toMatchObject({ action: "scrollUp", ok: true });
  });

  it("adds the dial steps that arrive while a scroll waits to that scroll", async () => {
    controller.applySettings(
      testSettings({ bindings: { dialClockwise: { action: "scrollDown" } }, scroll: { lines: 2 } }),
    );
    await connected(fakePaseo([snapshot("a")]).paseo);
    const release = await blockOnStop();
    for (let step = 0; step < 20; step += 1) bridge.dial("clockwise");
    await pause(30);
    release();
    await until(() => scrolls().length === 1);
    await controller.idle();
    await pause(20);
    expect(scrolls().map((command) => command.lines)).toEqual([40]);
  });

  it("scrolls fast in the turn's direction while the dial is held, and does not click", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    bridge.dial("press");
    bridge.dial("clockwise");
    await until(() => scrolls().length === 1);
    bridge.dial("counterclockwise");
    await until(() => scrolls().length === 2);
    bridge.dial("release");
    await controller.idle();
    await pause(20);
    expect(scrolls().map((command) => [command.lines, command.edge])).toEqual([
      [15, undefined],
      [-15, undefined],
    ]);
    expect(controller.status().lastAction).toMatchObject({
      action: "scrollUpFast",
      ok: true,
      message: "Scrolled up 15 lines",
    });
    expect(cliCalls).toEqual([]);
  });

  it("adds the fast and plain steps that arrive while a scroll waits to that scroll", async () => {
    controller.applySettings(
      testSettings({
        bindings: {
          dialClockwise: { action: "scrollDown" },
          dialHeldClockwise: { action: "scrollDownFast" },
        },
        scroll: { lines: 2, fastLines: 15 },
      }),
    );
    await connected(fakePaseo([snapshot("a")]).paseo);
    const release = await blockOnStop();
    bridge.dial("clockwise");
    bridge.dial("press");
    for (let step = 0; step < 4; step += 1) bridge.dial("clockwise");
    bridge.dial("release");
    await pause(30);
    release();
    await until(() => scrolls().length === 1);
    await controller.idle();
    await pause(20);
    // 2 + 4 × 15 = 62 lines in one scroll; more would stop at the bridge's 100.
    expect(scrolls().map((command) => command.lines)).toEqual([62]);
  });

  it("jumps to the bottom on every dial click, and never to the top", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    const click = () => {
      bridge.dial("press");
      bridge.dial("release");
    };
    click();
    await until(() => scrolls().length === 1);
    click();
    await until(() => scrolls().length === 2);
    bridge.dial("counterclockwise");
    await until(() => scrolls().length === 3);
    click();
    await until(() => scrolls().length === 4);
    await controller.idle();
    expect(scrolls()[0]).toEqual({
      type: "scroll",
      id: expect.any(Number),
      bundleID: "sh.paseo.desktop",
      edge: "bottom",
      activate: true,
      fromTop: 0.4,
    });
    expect(scrolls().map((command) => command.edge ?? command.lines)).toEqual([
      "bottom",
      "bottom",
      -3,
      "bottom",
    ]);
    expect(controller.status().lastAction).toMatchObject({
      action: "jumpToBottom",
      ok: true,
      message: "Jumped to the bottom",
    });
    expect(shortcuts("cmd+l")).toBe(0);
    expect(bridge.received.some((command) => command.type === "openURL")).toBe(false);
  });

  it("ignores dial clicks while a jump waits in the queue", async () => {
    controller.applySettings(testSettings({ bindings: { dialPress: { action: "jumpToBottom" } } }));
    await connected(fakePaseo([snapshot("a")]).paseo);
    const release = await blockOnStop();
    for (let click = 0; click < 5; click += 1) {
      bridge.dial("press");
      bridge.dial("release");
    }
    await pause(30);
    expect(controller.status().lastAction).toMatchObject({
      action: "jumpToBottom",
      ok: true,
      message: "Ignored: the last one has not finished",
    });
    release();
    await until(() => scrolls().length === 1);
    await controller.idle();
    await pause(20);
    expect(scrolls().map((command) => command.edge)).toEqual(["bottom"]);
  });

  it("ignores dial clicks while a jump runs, and jumps again after it ends", async () => {
    let unanswered = 1;
    respond = (command) =>
      command.type === "scroll" && command.edge !== undefined && unanswered-- > 0
        ? null
        : { ok: true };
    await connected(fakePaseo([snapshot("a")]).paseo);
    const click = () => {
      bridge.dial("press");
      bridge.dial("release");
    };
    click();
    await bridge.waitFor((command) => command.type === "scroll");
    for (let more = 0; more < 4; more += 1) click();
    await pause(30);
    expect(scrolls()).toHaveLength(1);
    expect(controller.status().lastAction).toMatchObject({
      message: "Ignored: the last one has not finished",
    });
    // The bridge does not answer the jump, so the request times out and the client reconnects.
    await until(() => controller.status().lastAction?.uncertain === true);
    await until(() => controller.status().bridge.state === "connected");
    click();
    await until(() => scrolls().length === 2);
    await controller.idle();
    expect(scrolls().map((command) => command.edge)).toEqual(["bottom", "bottom"]);
    expect(controller.status().lastAction).toMatchObject({
      action: "jumpToBottom",
      ok: true,
      message: "Jumped to the bottom",
    });
  });

  describe("with thinking on the held dial, as in settings version 6", () => {
    beforeEach(() => controller.applySettings(heldDialThinking()));

    it("changes thinking while the dial is held and shows the level on the keys for a moment", async () => {
      await connected(fakePaseo([snapshot("a")]).paseo);
      bridge.tap(0);
      bridge.dial("press");
      bridge.dial("clockwise");
      await until(() => cliCalls.includes("agent update a --thinking high"));
      // High is the third of three options, so the meter lights all six keys.
      const meter = lightsOf(
        await latestKeyLights((command) => lightsOf(command)[5]?.color === "#A05CFF"),
      );
      expect(meter.slice(0, 6).map((light) => light.color)).toEqual(Array(6).fill("#A05CFF"));
      // Then the keys return to their workspaces.
      const back = lightsOf(
        await latestKeyLights((command) => lightsOf(command)[5]?.color !== "#A05CFF"),
      );
      expect(back.every((light) => light.color !== "#A05CFF")).toBe(true);
      bridge.dial("counterclockwise");
      bridge.dial("release");
      await until(() => cliCalls.length === 2);
      // The snapshot still says medium, but the keypad set high, so one step down is medium.
      expect(cliCalls).toEqual([
        "agent update a --thinking high",
        "agent update a --thinking medium",
      ]);
      expect(shortcuts("cmd+l")).toBe(0);
    });

    it("changes thinking for an agent whose model is the family name opus", async () => {
      const fake = fakePaseo([snapshot("a", { model: "opus", thinkingOptionId: "high" })], {
        models: CLAUDE_MODELS,
      });
      await connected(fake.paseo);
      bridge.tap(0);
      bridge.dial("press");
      bridge.dial("clockwise");
      await until(() => cliCalls.length === 1);
      await controller.idle();
      expect(cliCalls).toEqual(["agent update a --thinking xhigh"]);
      expect(controller.status().lastAction).toMatchObject({ action: "thinkingUp", ok: true });
    });

    it("flashes the workspace keys red for a moment when a thinking change fails", async () => {
      const fake = fakePaseo([snapshot("a", { model: "sonnet" })], { models: CLAUDE_MODELS });
      await connected(fake.paseo);
      bridge.tap(0);
      bridge.dial("press");
      bridge.dial("clockwise");
      const flash = lightsOf(
        await latestKeyLights((command) =>
          lightsOf(command)
            .slice(0, 6)
            .every((l) => l.color === "#FF2D2D"),
        ),
      );
      expect(flash.slice(0, 6).map((light) => light.effect)).toEqual(Array(6).fill("solid"));
      expect(controller.status().lastAction).toMatchObject({
        action: "thinkingUp",
        ok: false,
        message: "Agent a's model, sonnet, is not among the claude models",
      });
      // Then the keys return to their workspaces.
      await latestKeyLights((command) => lightsOf(command)[5]?.color !== "#FF2D2D");
      expect(cliCalls).toEqual([]);
    });

    it("makes one change for the steps of a fast held turn that arrive during a change", async () => {
      const fake = fakePaseo([snapshot("a", { model: "opus", thinkingOptionId: "low" })], {
        models: CLAUDE_MODELS,
      });
      await connected(fake.paseo);
      bridge.tap(0);
      await bridge.waitFor((command) => command.type === "openURL");
      await controller.idle();
      const release = holdCli();
      bridge.dial("press");
      // As on the keypad on 2026-10-28: 11 steps within a second.
      for (let turn = 0; turn < 11; turn += 1) bridge.dial("clockwise");
      await until(() => cliCalls.length === 1);
      await pause(30);
      expect(cliCalls).toEqual(["agent update a --thinking medium"]);
      release();
      await until(() => cliCalls.length === 2);
      await controller.idle();
      // The other 10 steps go from medium, which the snapshot does not show yet, to the end.
      expect(cliCalls).toEqual([
        "agent update a --thinking medium",
        "agent update a --thinking ultracode",
      ]);
      expect(controller.status().lastAction).toMatchObject({ ok: true, action: "thinkingUp" });
    });

    it("keeps each direction of a held turn in order and lands on the right option", async () => {
      const fake = fakePaseo([snapshot("a", { model: "opus", thinkingOptionId: "low" })], {
        models: CLAUDE_MODELS,
      });
      await connected(fake.paseo);
      bridge.tap(0);
      await bridge.waitFor((command) => command.type === "openURL");
      await controller.idle();
      const release = holdCli();
      bridge.dial("press");
      for (const turn of ["clockwise", "clockwise", "clockwise", "counterclockwise"] as const) {
        bridge.dial(turn);
      }
      await until(() => cliCalls.length === 1);
      await pause(30);
      release();
      await until(() => cliCalls.length === 3);
      await controller.idle();
      // Low, up one to medium, up two more to xhigh, then down one to high.
      expect(cliCalls).toEqual([
        "agent update a --thinking medium",
        "agent update a --thinking xhigh",
        "agent update a --thinking high",
      ]);
    });

    it("starts from the snapshot again once it shows the keypad's change", async () => {
      const fake = fakePaseo([snapshot("a")]);
      await connected(fake.paseo);
      bridge.tap(0);
      bridge.dial("press");
      bridge.dial("clockwise");
      await until(() => cliCalls.length === 1);
      await controller.idle();
      // The snapshot shows the change, then a change from elsewhere back to medium.
      fake.upsert(snapshot("a", { thinkingOptionId: "high" }));
      fake.upsert(snapshot("a", { thinkingOptionId: "medium" }));
      await pause(20);
      bridge.dial("clockwise");
      await until(() => cliCalls.length === 2);
      expect(cliCalls).toEqual([
        "agent update a --thinking high",
        "agent update a --thinking high",
      ]);
    });

    it("drops a waiting thinking change with all its steps when input is lost", async () => {
      const fake = fakePaseo([snapshot("a", { model: "opus", thinkingOptionId: "low" })], {
        models: CLAUDE_MODELS,
      });
      await connected(fake.paseo);
      bridge.tap(0);
      await bridge.waitFor((command) => command.type === "openURL");
      await controller.idle();
      const release = holdCli();
      bridge.dial("press");
      for (let turn = 0; turn < 5; turn += 1) bridge.dial("clockwise");
      await until(() => cliCalls.length === 1);
      await pause(30);
      controller.settingsFailed("invalid settings");
      release();
      await controller.idle();
      await pause(20);
      expect(cliCalls).toEqual(["agent update a --thinking medium"]);
      expect(cliSignals[0]?.aborted).toBe(true);
    });
  });

  it("does nothing on the joystick until a direction has a prompt", async () => {
    controller.applySettings(withDefaults({ radialMenu: { enabled: false } }));
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.joystick(0.25, 1, 0);
    await until(() => controller.status().lastAction?.action === "sendPrompt");
    expect(controller.status().lastAction).toMatchObject({
      ok: true,
      message: "No prompt is set for this input",
    });
    expect(fake.calls.filter((call) => call.startsWith("send"))).toEqual([]);
  });

  it("sends a direction's prompt once for each deflection, from a sector key or the angle", async () => {
    controller.applySettings(
      withDefaults({
        radialMenu: { enabled: false },
        bindings: {
          joystickUp: { action: "sendPrompt", text: "Continue." },
          joystickLeft: { action: "sendPrompt", text: "Explain." },
        },
      }),
    );
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.tap(0);
    // Before any radial position, a sector key is a push.
    bridge.press(16);
    bridge.release(16);
    // Firmware 0.6.3 sends the radial positions, then the sector key, for one deflection.
    bridge.joystick(0.25, 1, 0);
    bridge.joystick(0.26, 1, 0);
    bridge.press(15);
    bridge.release(15);
    bridge.joystick(0, 0, -1);
    await until(() => fake.calls.filter((call) => call.startsWith("send")).length === 2);
    await controller.idle();
    await pause(20);
    expect(fake.calls.filter((call) => call.startsWith("send"))).toEqual([
      "send a Explain. steer",
      "send a Continue. steer",
    ]);
  });
});

describe("KeypadController radial menu", () => {
  type MenuCommand = {
    slots: { icon: string; label: string; color?: string; enabled: boolean }[];
    target: string | null;
    bundleID: string;
  };
  const menus = () =>
    bridge.received
      .filter((command) => command.type === "setRadialMenu")
      .map((command) => command as unknown as MenuCommand);
  const enabledOf = (menu: MenuCommand | undefined) => menu?.slots.map((slot) => slot.enabled);

  // The default settings, in which the menu is on.
  beforeEach(() => controller.applySettings(defaultSettings()));

  const waiting = () =>
    snapshot("a", {
      status: "running",
      pendingPermissions: [{ id: "r1", kind: "tool", title: "Run a command" }],
    });

  it("names the fallback agent without a selected workspace, and selects nothing", async () => {
    await connected(
      fakePaseo([waiting(), snapshot("b", { updatedAt: "2026-10-26T11:00:00.000Z" })]).paseo,
    );
    await until(() => menus().length > 0);
    // Agent a waits on a request, so key 7 would open it next, ahead of the more recent b.
    expect(menus().at(-1)?.target).toBe("Agent a");
    // The keypad's history is empty, so Back and Forward cannot act.
    expect(enabledOf(menus().at(-1))).toEqual([false, true, true, true, false, true, true, true]);
    expect(controller.status().radialMenu.target).toBe("Agent a");
    expect(controller.status().selectedWorkspaceId).toBeNull();
  });

  it("sends the default menu, with every slot dimmed until a workspace is selected, when the fallback is off", async () => {
    controller.applySettings(withDefaults({ targets: { fallback: "none" } }));
    await connected(fakePaseo([waiting()]).paseo);
    await until(() => menus().length > 0);
    const menu = menus()[0];
    expect(menu?.target).toBeNull();
    expect(menu?.bundleID).toBe("sh.paseo.desktop");
    expect(menu?.slots.map((slot) => slot.icon)).toEqual([
      "arrow.uturn.backward.circle",
      "testtube.2",
      "play.circle",
      "arrow.triangle.branch",
      "arrow.uturn.forward.circle",
      "magnifyingglass",
      "stop.circle",
      "list.bullet",
    ]);
    expect(menu?.slots[0]).toEqual({
      icon: "arrow.uturn.backward.circle",
      label: "Back",
      enabled: false,
    });
    expect(menu?.slots[1]).toEqual({ icon: "testtube.2", label: "Test", enabled: false });
    expect(enabledOf(menu)).toEqual(Array(8).fill(false));
  });

  it("names the selected workspace's agent and lights the slots that can act on it", async () => {
    const fake = fakePaseo([waiting()]);
    await connected(fake.paseo);
    bridge.tap(0);
    await until(() => menus().at(-1)?.target === "Agent a");
    expect(enabledOf(menus().at(-1))).toEqual([false, true, true, true, false, true, true, true]);
    expect(controller.status().radialMenu).toEqual({
      enabled: true,
      target: "Agent a",
      blockers: [
        "no earlier place in the keypad's history",
        null,
        null,
        null,
        "no later place in the keypad's history",
        null,
        null,
        null,
      ],
    });
  });

  it("lights Back and Forward when the keypad's history allows, and Stop only for a running agent", async () => {
    await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
    bridge.tap(0);
    await until(() => menus().at(-1)?.target === "Agent a");
    expect(enabledOf(menus().at(-1))).toEqual([false, true, true, true, false, true, false, true]);
    expect(controller.status().radialMenu.blockers[6]).toBe("Agent a is not running");
    bridge.tap(1);
    await until(() => menus().at(-1)?.target === "Agent b");
    await until(() => enabledOf(menus().at(-1))?.[0] === true);
    expect(enabledOf(menus().at(-1))?.[4]).toBe(false);
    bridge.pickRadial(0);
    await until(() => menus().at(-1)?.target === "Agent a");
    await until(() => enabledOf(menus().at(-1))?.[4] === true);
    expect(enabledOf(menus().at(-1))?.[0]).toBe(false);
  });

  it("sends the menu again only when it changes", async () => {
    controller.applySettings(withDefaults({ targets: { fallback: "none" } }));
    await connected(fakePaseo([waiting()]).paseo);
    await until(() => menus().length === 1);
    bridge.tap(0);
    await until(() => menus().length === 2);
    bridge.tap(0);
    await bridge.waitFor((command) => command.type === "openURL");
    await pause(80);
    expect(menus()).toHaveLength(2);
  });

  it("runs a picked slot's prompt and permission actions on the target", async () => {
    const fake = fakePaseo([waiting()]);
    await connected(fake.paseo);
    bridge.tap(0);
    await until(() => menus().at(-1)?.target === "Agent a");
    bridge.pickRadial(2);
    await until(() => fake.calls.some((call) => call.startsWith("send")));
    expect(fake.calls).toContain("send a Continue steer");
    bridge.pickRadial(6);
    await until(() => cliCalls.includes("stop a"));
    expect(controller.status().lastInput?.description).toBe("radial menu left");
  });

  it("goes back and forward from the radial menu's Back and Forward", async () => {
    await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
    const opened = () =>
      bridge.received.filter((command) => command.type === "openURL").map((command) => command.url);
    bridge.tap(0);
    bridge.tap(1);
    await until(() => opened().length === 2);
    await until(() => enabledOf(menus().at(-1))?.[0] === true);
    bridge.pickRadial(0);
    await until(() => opened().length === 3);
    await until(() => enabledOf(menus().at(-1))?.[4] === true);
    bridge.pickRadial(4);
    await until(() => opened().length === 4);
    expect(opened().slice(2)).toEqual([agentLink("srv_test", "a"), agentLink("srv_test", "b")]);
    expect(controller.status().lastAction).toMatchObject({ action: "navigateForward", ok: true });
  });

  it("skips a pick of a slot that can no longer act, and says why", async () => {
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.tap(0);
    await bridge.waitFor((command) => command.type === "openURL");
    await controller.idle();
    await until(() => menus().at(-1)?.target === "Agent a");
    bridge.pickRadial(4);
    await until(() => controller.status().lastAction?.action === "navigateForward");
    expect(controller.status().lastAction).toMatchObject({
      ok: false,
      message: "Skipped Forward (Down): no later place in the keypad's history",
    });
  });

  it("ignores the joystick's directions while the menu is on", async () => {
    controller.applySettings(
      withDefaults({
        bindings: { joystickUp: { action: "sendPrompt", text: "Continue." } },
      }),
    );
    const fake = fakePaseo([snapshot("a")]);
    await connected(fake.paseo);
    bridge.tap(0);
    bridge.joystick(0.25, 1, 0);
    bridge.press(15);
    bridge.release(15);
    bridge.joystick(0, 0, -1);
    await bridge.waitFor((command) => command.type === "openURL");
    await controller.idle();
    await pause(30);
    expect(fake.calls.filter((call) => call.startsWith("send"))).toEqual([]);
    expect(controller.status().lastInput?.description).toBe("joystick up (1.00)");
  });

  it("clears the menu when it is turned off, and ignores picks then", async () => {
    const fake = fakePaseo([waiting()]);
    await connected(fake.paseo);
    await until(() => menus().length > 0);
    bridge.clearReceived();
    controller.applySettings(withDefaults({ radialMenu: { enabled: false } }));
    await bridge.waitFor((command) => command.type === "clearRadialMenu");
    bridge.tap(0);
    await bridge.waitFor((command) => command.type === "openURL");
    await controller.idle();
    bridge.pickRadial(2);
    await until(() => controller.status().lastAction?.message === "The radial menu is off");
    expect(fake.calls.filter((call) => call.startsWith("send"))).toEqual([]);
  });

  it("sends the menu again after the app reconnects", async () => {
    await connected(fakePaseo([waiting()]).paseo);
    await until(() => menus().length === 1);
    bridge.disconnectClients();
    await reconnected();
    await until(() => menus().length === 2);
  });
});

describe("KeypadController input layers", () => {
  it("takes inputs on any layer that the app reports as an input layer, such as layer 2", async () => {
    await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
    bridge.setKeypad({ layer: 2, inputLayers: [2, 4] });
    await until(() => controller.status().keypad?.layer === 2);
    expect(controller.status().keypad?.inputLayers).toEqual([2, 4]);
    bridge.tap(1);
    await bridge.waitFor((command) => command.type === "openURL");
    expect(controller.status().selectedWorkspaceId).toBe("b");
  });

  it("ignores inputs and drops waiting work on a layer that is not an input layer", async () => {
    await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
    bridge.setKeypad({ layer: 2, inputLayers: [4] });
    await until(() => controller.status().keypad?.lightsVisible === false);
    bridge.tap(1);
    await pause(30);
    expect(bridge.received.some((command) => command.type === "openURL")).toBe(false);
    expect(controller.status().selectedWorkspaceId).toBeNull();
  });
});

describe("KeypadController cleanup", () => {
  it("cancels the running action and drops waiting ones when it stops", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    await blockOnStop();
    bridge.tap(11);
    await pause(20);
    await controller.stop();
    expect(cliSignals[0]?.aborted).toBe(true);
    expect(shortcuts("cmd+shift+d")).toBe(0);
    expect(bridge.received.at(-1)?.type).toBe("clearLights");
  });

  it("does not change thinking when the model lookup ends after it stops", async () => {
    let finishLookup = () => {};
    const modelsGate = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const fake = fakePaseo([snapshot("a")], { modelsGate });
    await connected(fake.paseo);
    bridge.tap(0);
    bridge.joystick(0.25, 1, 2);
    await until(() => fake.calls.includes("listModels"));
    await controller.stop();
    finishLookup();
    await pause(20);
    expect(cliCalls).toEqual([]);
  });
});

describe("KeypadController input loss", () => {
  const boundaries = ["settings", "bridge", "keypad", "layer"] as const;
  async function loseInput(boundary: (typeof boundaries)[number]) {
    if (boundary === "settings") controller.settingsFailed("invalid settings");
    else if (boundary === "bridge") {
      bridge.disconnectClients();
      await reconnected();
    } else {
      bridge.setKeypad(boundary === "keypad" ? { connected: false } : { layer: 1 });
      await until(() =>
        boundary === "keypad"
          ? controller.status().keypad?.connected === false
          : controller.status().keypad?.layer === 1,
      );
    }
  }

  it.each(boundaries)("cancels a model lookup on %s loss", async (boundary) => {
    let finish = () => {};
    const modelsGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fake = fakePaseo([snapshot("a")], { modelsGate });
    await connected(fake.paseo);
    bridge.tap(0);
    bridge.joystick(0.25, 1, 2);
    await until(() => fake.calls.includes("listModels"));
    bridge.tap(11);
    await pause(20);
    await loseInput(boundary);
    finish();
    await controller.idle();
    expect(cliCalls).toEqual([]);
    expect(shortcuts("cmd+shift+d")).toBe(0);
  });

  it.each(boundaries)("cancels delayed Return on %s loss", async (boundary) => {
    let finish = () => {};
    sleepGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    controller.applySettings(
      testSettings({ pushToTalk: { sendReturnOnRelease: true, returnDelayMs: 100 } }),
    );
    await connected(fakePaseo([]).paseo);
    bridge.tap(10);
    await until(() => sleeping);
    await loseInput(boundary);
    finish();
    await controller.idle();
    await pause(20);
    expect(shortcuts("cmd+d")).toBe(2);
    expect(shortcuts("return")).toBe(0);
  });

  it.each(["keypad", "layer"] as const)(
    "resets held keys and joystick on %s loss",
    async (boundary) => {
      await connected(fakePaseo([snapshot("a"), snapshot("b")]).paseo);
      bridge.press(10);
      bridge.joystick(0, 1, 0);
      await until(() => shortcuts("cmd+d") === 1);
      await controller.idle();
      expect(controller.status().selectedWorkspaceId).toBe("a");
      await loseInput(boundary);
      bridge.press(11);
      bridge.joystick(0, 1, 0);
      await pause(20);
      expect(shortcuts("cmd+shift+d")).toBe(0);
      expect(controller.status().selectedWorkspaceId).toBe("a");
      bridge.setKeypad({ connected: true, layer: 4 });
      bridge.press(10);
      bridge.release(10);
      bridge.joystick(0, 1, 0);
      await until(() => shortcuts("cmd+d") >= 3);
      await controller.idle();
      expect(shortcuts("cmd+d")).toBe(3);
      expect(controller.status().selectedWorkspaceId).toBe("b");
    },
  );
});

describe("KeypadController queued inputs", () => {
  it("keeps the binding an input had when it arrived", async () => {
    const fake = fakePaseo([snapshot("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] })]);
    controller.applySettings(testSettings({ bindings: { ACT12: { action: "none" } } }));
    await connected(fake.paseo);
    const release = await blockOnStop();
    bridge.tap(12);
    await pause(20);
    controller.applySettings(
      testSettings({ bindings: { ACT12: { action: "approvePermission" } } }),
    );
    release();
    await controller.idle();
    expect(fake.calls).toEqual([]);
  });

  it("does not open another workspace when the pressed key's workspace changes", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    await connected(fakePaseo(ids.map((id) => snapshot(id))).paseo);
    const release = await blockOnStop();
    bridge.tap(1);
    await pause(20);
    controller.forgetWorkspace("b");
    expect(controller.status().keys[1]?.workspaceId).toBe("g");
    bridge.clearReceived();
    release();
    await controller.idle();
    expect(bridge.received.filter((command) => command.type === "openURL")).toEqual([]);
  });

  it("does not answer a request other than the one pending at the press", async () => {
    const fake = fakePaseo([snapshot("a", { pendingPermissions: [{ id: "r1", kind: "tool" }] })]);
    await connected(fake.paseo);
    const release = await blockOnStop();
    bridge.tap(7);
    await pause(20);
    fake.upsert(snapshot("a", { pendingPermissions: [{ id: "r2", kind: "tool" }] }));
    release();
    await controller.idle();
    expect(fake.calls).toEqual([]);
    expect(controller.status().lastAction?.message).toContain("already answered");
  });

  it("lets only a bounded number of actions wait", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    const release = await blockOnStop();
    for (let count = 0; count < MAX_QUEUED_ACTIONS + 4; count += 1) bridge.tap(11);
    await pause(30);
    release();
    await controller.idle();
    await pause(20);
    expect(shortcuts("cmd+shift+d")).toBe(MAX_QUEUED_ACTIONS);
  });

  it("drops waiting actions when the keypad app disconnects", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    const release = await blockOnStop();
    bridge.tap(11);
    bridge.tap(11);
    await pause(20);
    bridge.disconnectClients();
    await reconnected();
    release();
    await controller.idle();
    await pause(20);
    expect(shortcuts("cmd+shift+d")).toBe(0);
  });
});

describe("KeypadController push to talk", () => {
  it.each(["started", "queued", "active"] as const)(
    "preserves a talk release with a full queue and a %s start",
    async (state) => {
      await connected(fakePaseo([snapshot("a")]).paseo);
      let release = () => {};
      let startCommand: ReceivedCommand | undefined;
      if (state === "queued") release = await blockOnStop();
      if (state === "active") {
        respond = (command) => {
          if (command.shortcut === "cmd+d" && !startCommand) {
            startCommand = command;
            return null;
          }
          return { ok: true };
        };
      }
      bridge.press(10);
      if (state !== "queued") {
        await until(() => shortcuts("cmd+d") === 1);
        if (state === "started") {
          await controller.idle();
          release = await blockOnStop();
        }
      }
      for (let index = 0; index < MAX_QUEUED_ACTIONS + 2; index += 1) bridge.tap(11);
      bridge.release(10);
      await pause(20);
      if (startCommand)
        bridge.sendRaw(`${JSON.stringify({ type: "result", id: startCommand.id, ok: true })}\n`);
      release();
      await controller.idle();
      expect(shortcuts("cmd+d")).toBe(2);
      expect(shortcuts("cmd+shift+d")).toBeLessThanOrEqual(MAX_QUEUED_ACTIONS - 1);
    },
  );

  it("does not stop a talk start rejected by the full queue", async () => {
    await connected(fakePaseo([snapshot("a")]).paseo);
    const release = await blockOnStop();
    for (let index = 0; index < MAX_QUEUED_ACTIONS; index += 1) bridge.tap(11);
    bridge.press(10);
    await pause(20);
    release();
    await controller.idle();
    bridge.release(10);
    await pause(20);
    await controller.idle();
    expect(shortcuts("cmd+d")).toBe(0);
  });

  it("ignores a release without its press", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.release(10);
    await pause(30);
    await controller.idle();
    expect(shortcuts("cmd+d")).toBe(0);
  });

  it("ignores a second press while the key is held", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.press(10);
    bridge.press(10);
    bridge.release(10);
    await pause(30);
    await controller.idle();
    expect(shortcuts("cmd+d")).toBe(2);
  });

  it("does not stop dictation that failed to start", async () => {
    respond = (command) =>
      command.shortcut === "cmd+d" ? { ok: false, error: "no permission" } : { ok: true };
    await connected(fakePaseo([]).paseo);
    bridge.press(10);
    bridge.release(10);
    await pause(30);
    await controller.idle();
    expect(shortcuts("cmd+d")).toBe(1);
  });

  it("forgets a held key when the keypad app disconnects", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.press(10);
    await until(() => shortcuts("cmd+d") === 1);
    await controller.idle();
    bridge.disconnectClients();
    await reconnected();
    bridge.release(10);
    await pause(30);
    await controller.idle();
    expect(shortcuts("cmd+d")).toBe(1);
  });

  describe("on the shared keycap of keys 11 and 12", () => {
    beforeEach(() => controller.applySettings(defaultSettings()));

    it.each([10, 11])("starts and stops dictation once when only key %s closes", async (key) => {
      await connected(fakePaseo([]).paseo);
      bridge.press(key);
      await until(() => shortcuts("cmd+d") === 1);
      bridge.release(key);
      await until(() => shortcuts("cmd+d") === 2);
      await pause(20);
      await controller.idle();
      expect(shortcuts("cmd+d")).toBe(2);
    });

    it.each([
      ["key 11", 10, 11],
      ["key 12", 11, 10],
    ])(
      "starts once when both keys close and stops when %s is released last",
      async (_name, firstUp, lastUp) => {
        await connected(fakePaseo([]).paseo);
        bridge.press(10);
        bridge.press(11);
        await until(() => shortcuts("cmd+d") === 1);
        bridge.release(firstUp);
        await pause(30);
        await controller.idle();
        expect(shortcuts("cmd+d")).toBe(1);
        bridge.release(lastUp);
        await until(() => shortcuts("cmd+d") === 2);
        await pause(20);
        await controller.idle();
        expect(shortcuts("cmd+d")).toBe(2);
      },
    );

    it("does not stop early when the switches open and close in turn", async () => {
      await connected(fakePaseo([]).paseo);
      bridge.press(11);
      bridge.press(10);
      bridge.release(11);
      bridge.press(11);
      bridge.release(10);
      await pause(30);
      await controller.idle();
      expect(shortcuts("cmd+d")).toBe(1);
      bridge.release(11);
      await until(() => shortcuts("cmd+d") === 2);
    });

    it("forgets a held keycap when the keypad app disconnects", async () => {
      await connected(fakePaseo([]).paseo);
      bridge.press(10);
      bridge.press(11);
      await until(() => shortcuts("cmd+d") === 1);
      await controller.idle();
      bridge.disconnectClients();
      await reconnected();
      bridge.release(10);
      bridge.release(11);
      await pause(30);
      await controller.idle();
      expect(shortcuts("cmd+d")).toBe(1);
    });
  });

  it("stops with the binding the key had when pressed", async () => {
    await connected(fakePaseo([]).paseo);
    bridge.press(10);
    await until(() => shortcuts("cmd+d") === 1);
    controller.applySettings(testSettings({ bindings: { ACT10: { action: "none" } } }));
    bridge.release(10);
    await until(() => shortcuts("cmd+d") === 2);
  });
});

describe("KeypadController bridge pressure", () => {
  it("reports an unanswered action as uncertain and never sends it again", async () => {
    respond = (command) => (command.shortcut === "cmd+shift+d" ? null : { ok: true });
    await connected(fakePaseo([]).paseo);
    bridge.tap(11);
    await until(() => controller.status().lastAction !== null);
    expect(controller.status().lastAction).toMatchObject({
      action: "toggleVoiceMode",
      ok: false,
      uncertain: true,
    });
    await until(() => controller.status().bridge.state === "connected");
    await pause(50);
    expect(shortcuts("cmd+shift+d")).toBe(1);
  });

  it("reports an action as uncertain when the peer receives it and closes without a result", async () => {
    respond = (command) => (command.shortcut === "cmd+shift+d" ? null : { ok: true });
    await connected(fakePaseo([]).paseo);
    bridge.tap(11);
    await bridge.waitFor((command) => command.shortcut === "cmd+shift+d");
    bridge.disconnectClients();
    await until(() => controller.status().lastAction !== null);
    expect(controller.status().lastAction).toMatchObject({
      action: "toggleVoiceMode",
      ok: false,
      uncertain: true,
    });
  });

  it("keeps one light frame in flight and coalesces the rest", async () => {
    const fake = fakePaseo([snapshot("a")]);
    respond = (command) => (command.type === "setKeyLights" ? null : { ok: true });
    await connected(fake.paseo);
    for (const status of ["running", "idle", "running", "idle"]) {
      fake.upsert(snapshot("a", { status }));
      await pause(10);
    }
    expect(bridge.received.filter((command) => command.type === "setKeyLights")).toHaveLength(1);
  });
});

describe("resolveSocketPath", () => {
  it("uses the app's socket by default and expands the home directory", () => {
    expect(resolveSocketPath("", "/Users/me")).toBe(
      "/Users/me/Library/Application Support/PaseoMicro/bridge.sock",
    );
    expect(resolveSocketPath("~/b.sock", "/Users/me")).toBe("/Users/me/b.sock");
    expect(resolveSocketPath("/tmp/b.sock", "/Users/me")).toBe("/tmp/b.sock");
  });
});

describe("agentLink", () => {
  it("builds a Paseo agent link", () => {
    expect(agentLink("srv_wGFm", "0b95b862-1c4e")).toBe("paseo://h/srv_wGFm/agent/0b95b862-1c4e");
  });
});
