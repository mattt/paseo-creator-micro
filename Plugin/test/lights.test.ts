import { describe, expect, it } from "vite-plus/test";
import type { AgentInfo } from "../server/agents";
import {
  actionKeyLights,
  computeLights,
  keyLight,
  underglowLight,
  type KeyOverlay,
} from "../server/lights";
import { agentsByWorkspace, type WorkspaceInfo } from "../server/workspaces";
import { DEFAULT_SETTINGS, SettingsSchema } from "../shared/settings";
import { agent, permission, workspace } from "./fixtures";

const lights = DEFAULT_SETTINGS.lights;

/** The lights with the underglow of settings version 7: yellow while any agent needs input. */
const needsInputGlow = SettingsSchema.parse({
  lights: { underglowSource: "anyNeedsInput" },
}).lights;

function frame(
  slots: (string | null)[],
  workspaces: WorkspaceInfo[],
  agents: AgentInfo[],
  selected: string | null = null,
  settings = lights,
  nextAgent: AgentInfo | null = null,
) {
  return computeLights(
    slots,
    new Map(workspaces.map((entry) => [entry.id, entry])),
    agents,
    agentsByWorkspace(agents),
    selected,
    settings,
    { nextAgent },
  );
}

describe("default state colors", () => {
  it("are red, yellow, blue, green, and off", () => {
    expect(keyLight(0, "failed", false, lights)).toMatchObject({
      color: "#FF2D2D",
      effect: "solid",
    });
    expect(keyLight(0, "needsInput", false, lights)).toMatchObject({
      color: "#FFD000",
      effect: "breathing",
    });
    expect(keyLight(0, "running", false, lights)).toMatchObject({
      color: "#2D7BFF",
      effect: "solid",
    });
    expect(keyLight(0, "done", false, lights)).toMatchObject({
      color: "#2DFF6A",
      effect: "solid",
      brightness: 0.3,
    });
    for (const state of ["idle", "empty"] as const) {
      expect(keyLight(0, state, false, lights)).toEqual({
        key: 0,
        color: "#000000",
        effect: "off",
        brightness: 0,
        speed: 0,
      });
    }
  });
});

describe("keyLight", () => {
  it("brightens the selected workspace's key, up to full brightness", () => {
    expect(keyLight(2, "done", true, lights).brightness).toBe(0.6);
    expect(keyLight(2, "needsInput", true, lights).brightness).toBe(1);
  });

  it("shows a selected key that would be off in dim white", () => {
    expect(keyLight(1, "idle", true, lights)).toEqual({
      key: 1,
      color: "#FFFFFF",
      effect: "solid",
      brightness: 0.15,
      speed: 0.5,
    });
    expect(keyLight(1, "idle", false, lights).effect).toBe("off");
  });

  it("uses the configured selected-off light, also for a state turned off by brightness", () => {
    const custom = SettingsSchema.parse({
      lights: {
        selectedOff: { color: "#00ffff", effect: "breathing", brightness: 0.2 },
        done: { color: "#2DFF6A", effect: "solid", brightness: 0 },
      },
    }).lights;
    expect(keyLight(3, "idle", true, custom)).toMatchObject({
      color: "#00FFFF",
      effect: "breathing",
      brightness: 0.2,
    });
    expect(keyLight(3, "done", true, custom)).toMatchObject({ color: "#00FFFF" });
    const hidden = SettingsSchema.parse({
      lights: { selectedOff: { color: "#FFFFFF", effect: "off", brightness: 0 } },
    }).lights;
    expect(keyLight(3, "idle", true, hidden).effect).toBe("off");
  });

  it("uses configured colors", () => {
    const custom = SettingsSchema.parse({
      lights: { running: { color: "#ffb000", effect: "snake", brightness: 0.7, speed: 0.2 } },
    }).lights;
    expect(keyLight(4, "running", false, custom)).toEqual({
      key: 4,
      color: "#FFB000",
      effect: "snake",
      brightness: 0.7,
      speed: 0.2,
    });
  });
});

describe("computeLights", () => {
  it("lights each workspace key by its agents and leaves empty keys off", () => {
    const agents = [
      agent({ workspaceId: "a", status: "running" }),
      agent({ workspaceId: "a" }),
      agent({ workspaceId: "b", status: "error" }),
      agent({ workspaceId: "b", pendingPermissions: [permission()] }),
    ];
    const result = frame(
      ["a", "b", "c", null, null, null],
      [workspace({ id: "a" }), workspace({ id: "b" }), workspace({ id: "c" })],
      agents,
    );
    expect(result.states).toEqual(["running", "failed", "idle", "empty", "empty", "empty"]);
    expect(result.keys.map((light) => light.key)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.keys[0]?.color).toBe("#2D7BFF");
    expect(result.keys[1]?.color).toBe("#FF2D2D");
    expect(result.keys[2]?.effect).toBe("off");
  });

  it("brightens only the selected workspace's key", () => {
    const unread = { requiresAttention: true, attentionReason: "finished" } as const;
    const agents = [agent({ workspaceId: "a", ...unread }), agent({ workspaceId: "b", ...unread })];
    const result = frame(
      ["a", "b", null, null, null, null],
      [workspace({ id: "a" }), workspace({ id: "b" })],
      agents,
      "b",
    );
    expect(result.keys[0]?.brightness).toBe(0.3);
    expect(result.keys[1]?.brightness).toBe(0.6);
  });

  it("shows a selected idle workspace in dim white and other idle workspaces off", () => {
    const agents = [agent({ workspaceId: "a" }), agent({ workspaceId: "b" })];
    const result = frame(
      ["a", "b", null, null, null, null],
      [workspace({ id: "a" }), workspace({ id: "b" })],
      agents,
      "b",
    );
    expect(result.states.slice(0, 2)).toEqual(["idle", "idle"]);
    expect(result.keys[0]?.effect).toBe("off");
    expect(result.keys[1]).toMatchObject({ color: "#FFFFFF", effect: "solid", brightness: 0.15 });
  });

  it("lights the other keys with the keys zone", () => {
    expect(frame([null, null, null, null, null, null], [], []).keysZone).toEqual({
      color: "#FFFFFF",
      effect: "solid",
      brightness: 0.1,
      speed: 0.5,
    });
  });
});

describe("the underglow while any agent needs input", () => {
  const yellow = { color: "#FFD000", effect: "breathing", brightness: 0.4, speed: 0.5 };

  it("lights yellow while an agent on a key needs input", () => {
    const result = frame(
      ["a", null, null, null, null, null],
      [workspace({ id: "a" })],
      [agent({ workspaceId: "a", pendingPermissions: [permission()] })],
      null,
      needsInputGlow,
    );
    expect(result.needsInput).toBe(true);
    expect(result.ambient).toEqual(yellow);
  });

  it("lights for an agent in a workspace without a key, or without a workspace", () => {
    const off = agent({
      workspaceId: "off-key",
      requiresAttention: true,
      attentionReason: "permission",
    });
    const none = [null, null, null, null, null, null];
    expect(frame(none, [], [off], null, needsInputGlow).ambient).toEqual(yellow);
    const loose = agent({ pendingPermissions: [permission({ kind: "question" })] });
    expect(frame(none, [], [loose], null, needsInputGlow).ambient).toEqual(yellow);
  });

  it("stays off for failed, running, done, and idle agents", () => {
    const agents = [
      agent({ workspaceId: "a", status: "error" }),
      agent({ workspaceId: "a", status: "running" }),
      agent({ workspaceId: "a", requiresAttention: true, attentionReason: "finished" }),
      agent({ workspaceId: "a" }),
    ];
    const result = frame(
      ["a", null, null, null, null, null],
      [workspace({ id: "a" })],
      agents,
      null,
      needsInputGlow,
    );
    expect(result.needsInput).toBe(false);
    expect(result.ambient.effect).toBe("off");
  });

  it("stays off when it is turned off, and uses the configured style", () => {
    const disabled = SettingsSchema.parse({ lights: { underglowSource: "off" } }).lights;
    expect(underglowLight(true, "needsInput", disabled).effect).toBe("off");
    const custom = SettingsSchema.parse({
      lights: {
        underglowSource: "anyNeedsInput",
        underglowStyle: { color: "#ff8800", effect: "solid", brightness: 0.2 },
      },
    }).lights;
    expect(underglowLight(true, null, custom)).toEqual({
      color: "#FF8800",
      effect: "solid",
      brightness: 0.2,
      speed: 0.5,
    });
    expect(underglowLight(false, "failed", custom).effect).toBe("off");
  });
});

describe("the next agent that needs action", () => {
  const none = [null, null, null, null, null, null];
  const asking = agent({ pendingPermissions: [permission()] });
  const failed = agent({ status: "error" });
  const unread = agent({ requiresAttention: true, attentionReason: "finished" });

  it("lights key 6 and the underglow by default, in the state colors", () => {
    expect(lights.underglowSource).toBe("nextActionableAgent");
    for (const [next, color, effect] of [
      [asking, "#FFD000", "breathing"],
      [failed, "#FF2D2D", "solid"],
      [unread, "#2DFF6A", "solid"],
    ] as const) {
      const result = frame(none, [], [next], null, lights, next);
      expect(result.keys).toHaveLength(7);
      expect(result.keys[6]).toMatchObject({ key: 6, color, effect });
      expect(result.ambient).toMatchObject({ color, effect });
      expect(result.actionKeys).toEqual([
        { key: 6, source: "nextActionableAgent", state: actionStateOf(next) },
      ]);
    }
  });

  it("turns key 6 and the underglow off when no agent needs action", () => {
    const result = frame(none, [], [asking], null, lights, null);
    expect(result.keys[6]).toEqual({
      key: 6,
      color: "#000000",
      effect: "off",
      brightness: 0,
      speed: 0,
    });
    expect(result.ambient.effect).toBe("off");
    expect(result.actionKeys).toEqual([{ key: 6, source: "nextActionableAgent", state: null }]);
  });

  it("lights the keys that the settings give the source, and no others", () => {
    const settings = SettingsSchema.parse({
      lights: { actionKeys: { ACT06: "none", ACT12: "nextActionableAgent" } },
    }).lights;
    const result = actionKeyLights("done", settings);
    expect(result.keys.map((light) => light.key)).toEqual([12]);
    expect(result.keys[0]?.color).toBe("#2DFF6A");
    expect(frame(none, [], [], null, settings, unread).keys.map((light) => light.key)).toEqual([
      0, 1, 2, 3, 4, 5, 12,
    ]);
    const unlit = SettingsSchema.parse({ lights: { actionKeys: { ACT06: "none" } } }).lights;
    expect(frame(none, [], [], null, unlit, unread).keys).toHaveLength(6);
  });

  it("keeps key 6 lit while an overlay shows on the workspace keys", () => {
    const result = computeLights(none, new Map(), [asking], new Map(), null, lights, {
      overlay: { kind: "failure" },
      nextAgent: asking,
    });
    expect(result.keys[6]).toMatchObject({ key: 6, color: "#FFD000" });
  });
});

function actionStateOf(next: AgentInfo) {
  if (next.status === "error") return "failed";
  return next.pendingPermissions.length > 0 ? "needsInput" : "done";
}

describe("key overlays", () => {
  const slots = ["a", null, null, null, null, null];
  const workspaces = [workspace({ id: "a" })];
  const agents = [agent({ workspaceId: "a", status: "running" })];
  const overlaid = (overlay: KeyOverlay) =>
    computeLights(
      slots,
      new Map(workspaces.map((entry) => [entry.id, entry])),
      agents,
      agentsByWorkspace(agents),
      null,
      lights,
      { overlay },
    );

  it("show the meter with its lit keys first", () => {
    const meter = overlaid({ kind: "meter", lit: 2 });
    expect(meter.keys.slice(0, 6).map((light) => light.color)).toEqual([
      "#A05CFF",
      "#A05CFF",
      "#000000",
      "#000000",
      "#000000",
      "#000000",
    ]);
    expect(meter.states[0]).toBe("running");
  });

  it("flash every workspace key in the failure light, red by default", () => {
    const failure = overlaid({ kind: "failure" });
    expect(failure.keys).toHaveLength(7);
    for (const light of failure.keys.slice(0, 6)) {
      expect(light).toMatchObject({ color: "#FF2D2D", effect: "solid", brightness: 0.8 });
    }
    expect(failure.states[0]).toBe("running");
  });
});

describe("subagents", () => {
  const slots = ["a", null, null, null, null, null];
  const workspaces = [workspace({ id: "a" })];
  const askingSub = agent({
    workspaceId: "a",
    parentAgentId: "parent",
    pendingPermissions: [permission()],
  });
  const lightsFor = (agents: AgentInfo[], includeSubagents?: boolean) =>
    computeLights(
      slots,
      new Map(workspaces.map((entry) => [entry.id, entry])),
      agents,
      agentsByWorkspace(agents),
      null,
      needsInputGlow,
      includeSubagents === undefined ? {} : { includeSubagents },
    );

  it("leave the key and the underglow off when the only waiting agent is a subagent", () => {
    const result = lightsFor([askingSub, agent({ workspaceId: "a" })]);
    expect(result.states[0]).toBe("idle");
    expect(result.keys[0]?.effect).toBe("off");
    expect(result.needsInput).toBe(false);
    expect(result.ambient.effect).toBe("off");
  });

  it("leave failed and done colors off", () => {
    const failedSub = agent({ workspaceId: "a", parentAgentId: "parent", status: "error" });
    const doneSub = agent({
      workspaceId: "a",
      parentAgentId: "parent",
      requiresAttention: true,
      attentionReason: "finished",
    });
    expect(lightsFor([failedSub, doneSub]).states[0]).toBe("idle");
  });

  it("light the key blue while they run", () => {
    const running = agent({ workspaceId: "a", parentAgentId: "parent", status: "running" });
    const result = lightsFor([running]);
    expect(result.states[0]).toBe("running");
    expect(result.keys[0]?.color).toBe("#2D7BFF");
  });

  it("light the key and the underglow when the settings include them", () => {
    const result = lightsFor([askingSub], true);
    expect(result.states[0]).toBe("needsInput");
    expect(result.needsInput).toBe(true);
    expect(result.ambient.effect).toBe("breathing");
  });
});
