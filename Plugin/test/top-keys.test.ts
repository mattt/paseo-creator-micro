import { describe, expect, it } from "vite-plus/test";
import { topKeyLight } from "../server/lights";
import { TapTracker, topKeys } from "../server/top-keys";
import { agentsByWorkspace } from "../server/workspaces";
import { DEFAULT_SETTINGS, DOUBLE_TAP_MS, SettingsSchema } from "../shared/settings";
import { agent, environment, permission, workspace } from "./fixtures";

const lights = DEFAULT_SETTINGS.lights;

describe("TapTracker", () => {
  it("counts a second tap of the same key and agent within the window as a double tap", () => {
    const taps = new TapTracker();
    expect(taps.tap(0, "a", 1_000)).toBe(false);
    expect(taps.tap(0, "a", 1_000 + DOUBLE_TAP_MS)).toBe(true);
    // A third tap starts a new pair.
    expect(taps.tap(0, "a", 1_100 + DOUBLE_TAP_MS)).toBe(false);
  });

  it("does not count a slow tap, another key, or another agent on the same key", () => {
    const taps = new TapTracker(400);
    taps.tap(0, "a", 0);
    expect(taps.tap(0, "a", 401)).toBe(false);
    expect(taps.tap(1, "a", 500)).toBe(false);
    expect(taps.tap(1, "b", 600)).toBe(false);
    taps.reset();
    expect(taps.tap(1, "b", 700)).toBe(false);
  });
});

describe("topKeyLight", () => {
  it("lights a navigation key that can act in the navigation light, and turns off the rest", () => {
    expect(
      topKeyLight(
        2,
        { kind: "navigation", state: "empty", selected: false, enabled: true },
        lights,
      ),
    ).toEqual({
      key: 2,
      color: "#FFFFFF",
      effect: "solid",
      brightness: 0.15,
      speed: 0.5,
    });
    for (const input of [
      { kind: "navigation", state: "empty", selected: false, enabled: false },
      { kind: "off", state: "empty", selected: false, enabled: false },
    ] as const) {
      expect(topKeyLight(0, input, lights)).toMatchObject({ effect: "off", brightness: 0 });
    }
  });

  it("lights a workspace or agent key in its state's light, brighter when selected", () => {
    expect(
      topKeyLight(1, { kind: "agent", state: "running", selected: false, enabled: true }, lights),
    ).toMatchObject({ color: "#2D7BFF", brightness: 0.5 });
    expect(
      topKeyLight(1, { kind: "agent", state: "done", selected: true, enabled: true }, lights),
    ).toMatchObject({ color: "#2DFF6A", brightness: 0.6 });
    expect(
      topKeyLight(1, { kind: "workspace", state: "idle", selected: true, enabled: true }, lights),
    ).toMatchObject({ color: "#FFFFFF", brightness: 0.15 });
  });
});

describe("topKeys", () => {
  const settingsFor = (mode: string, extra: Record<string, unknown> = {}) =>
    SettingsSchema.parse({ topKeys: { mode }, ...extra });

  it("describes the navigation keys and whether each can act", () => {
    const agents = [agent({ id: "x", workspaceId: "a" }), agent({ id: "y", workspaceId: "b" })];
    const { env, recorded } = environment(agents, {
      workspaces: [
        workspace({ id: "a", projectId: "p", projectName: "p" }),
        workspace({ id: "b", projectId: "q", projectName: "q" }),
      ],
    });
    const enabled = () =>
      topKeys(env, agentsByWorkspace(agents)).map((key) => [key.action, key.enabled]);
    expect(enabled()).toEqual([
      ["navigateBack", false],
      ["navigateForward", false],
      ["previousProject", true],
      ["previousWorkspace", true],
      ["nextWorkspace", true],
      ["nextProject", true],
    ]);
    recorded.history.visit({ workspaceId: "a", agentId: "x" });
    recorded.history.visit({ workspaceId: "b", agentId: "y" });
    expect(enabled()[0]).toEqual(["navigateBack", true]);
    recorded.history.back(() => true);
    expect(enabled().slice(0, 2)).toEqual([
      ["navigateBack", false],
      ["navigateForward", true],
    ]);
  });

  it("describes recent agents with their states, and the selected agent", () => {
    const agents = [
      agent({ id: "x", title: "X", workspaceId: "a", pendingPermissions: [permission()] }),
      agent({ id: "y", workspaceId: "a", status: "running" }),
    ];
    const { env } = environment(agents, {
      workspaces: [workspace({ id: "a", projectName: "proj" })],
      agentSlots: ["y", "x", null, null, null, null],
      settings: settingsFor("recentAgents"),
    });
    env.selectAgent("y", "a");
    const keys = topKeys(env, agentsByWorkspace(agents));
    expect(keys.slice(0, 3).map((key) => [key.kind, key.agentId, key.state, key.selected])).toEqual(
      [
        ["agent", "y", "running", true],
        ["agent", "x", "needsInput", false],
        ["agent", null, "empty", false],
      ],
    );
    expect(keys[1]).toMatchObject({ title: "X", project: "proj", workspaceId: "a", enabled: true });
  });

  it("describes workspaces, pins, and the off mode", () => {
    const agents = [agent({ workspaceId: "a", status: "error" })];
    const options = {
      workspaces: [workspace({ id: "a" })],
      slots: ["a", null, null, null, null, null],
      selected: "a",
    };
    const pinned = environment(agents, {
      ...options,
      settings: settingsFor("pinned", { pins: ["a", null, null, null, null, null] }),
    });
    expect(topKeys(pinned.env, agentsByWorkspace(agents))[0]).toMatchObject({
      kind: "workspace",
      workspaceId: "a",
      state: "failed",
      pinned: true,
      selected: true,
      agentCount: 1,
    });
    const off = environment(agents, { ...options, settings: settingsFor("off") });
    expect(topKeys(off.env, agentsByWorkspace(agents)).map((key) => key.kind)).toEqual(
      Array(6).fill("off"),
    );
  });
});
