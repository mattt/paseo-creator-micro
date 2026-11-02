import { describe, expect, it } from "vite-plus/test";
import { runPlan } from "../server/actions";
import { InputMapper, describeInput } from "../server/input-map";
import {
  planRadialSlot,
  radialMenuCommand,
  radialTarget,
  slotBlocker,
} from "../server/radial-menu";
import { parseAppLine } from "../server/bridge-protocol";
import { DEFAULT_SETTINGS, SettingsSchema, type RadialSlot } from "../shared/settings";
import { agent, environment, permission, workspace } from "./fixtures";

const slot = (overrides: Partial<RadialSlot>): RadialSlot => ({
  icon: "star",
  label: "Star",
  color: null,
  action: "none",
  text: "",
  ...overrides,
});

/** A selected workspace `w` whose only agent `a` is running and waits on a request. */
function busy(overrides: Parameters<typeof agent>[0] = {}) {
  const request = permission({ id: "r1" });
  const target = agent({
    id: "a",
    title: "Fix the build",
    workspaceId: "w",
    status: "running",
    pendingPermissions: [request],
    ...overrides,
  });
  return environment([target], { workspaces: [workspace({ id: "w" })], selected: "w" });
}

/**
 * `busy` with places before and after the current one in the keypad's history,
 * so that Back and Forward can act; each place opens agent a.
 */
function busyWithHistory(overrides: Parameters<typeof agent>[0] = {}) {
  const fixture = busy(overrides);
  const { history } = fixture.recorded;
  for (const agentId of ["earlier", "a", "later"]) history.visit({ workspaceId: "w", agentId });
  history.back(() => true);
  return fixture;
}

describe("radialTarget", () => {
  it("is the selected workspace's most relevant agent", () => {
    const { env } = environment(
      [
        agent({ id: "old", workspaceId: "w", activityAt: 10 }),
        agent({ id: "recent", workspaceId: "w", activityAt: 20 }),
        agent({ id: "elsewhere", workspaceId: "v", activityAt: 30 }),
      ],
      { workspaces: [workspace({ id: "w" }), workspace({ id: "v" })], selected: "w" },
    );
    expect(radialTarget(env)?.id).toBe("recent");
  });

  it("skips subagents unless the settings include them", () => {
    const agents = [agent({ id: "child", workspaceId: "w", parentAgentId: "parent" })];
    const options = { workspaces: [workspace({ id: "w" })], selected: "w" };
    expect(radialTarget(environment(agents, options).env)).toBeNull();
    const settings = SettingsSchema.parse({ agents: { includeSubagents: true } });
    expect(radialTarget(environment(agents, { ...options, settings }).env)?.id).toBe("child");
  });

  it("is null without a selected workspace when the fallback is off", () => {
    const settings = SettingsSchema.parse({ targets: { fallback: "none" } });
    expect(radialTarget(environment([agent({ workspaceId: "w" })], { settings }).env)).toBeNull();
  });

  it("falls back to the agent that key 7 would open next without a selected workspace", () => {
    const { env, recorded } = environment(
      [
        agent({ id: "recent", workspaceId: "w", activityAt: 90 }),
        agent({ id: "failed", workspaceId: "v", status: "error", activityAt: 20 }),
        agent({
          id: "asking",
          workspaceId: "v",
          attentionAt: 10,
          activityAt: 10,
          pendingPermissions: [permission()],
        }),
      ],
      { workspaces: [workspace({ id: "w" }), workspace({ id: "v" })] },
    );
    expect(radialTarget(env)?.id).toBe("asking");
    // Like key 7, it moves past the agent that the keypad opened last.
    recorded.opened = "asking";
    expect(radialTarget(env)?.id).toBe("failed");
    // Choosing the target selects nothing.
    expect(recorded.selected).toBeNull();
  });

  it("falls back to the most recently active agent when no agent needs action", () => {
    const { env } = environment([
      agent({ id: "old", workspaceId: "w", activityAt: 10 }),
      agent({ id: "recent", workspaceId: "v", activityAt: 30 }),
      agent({ id: "child", workspaceId: "v", activityAt: 50, parentAgentId: "recent" }),
    ]);
    expect(radialTarget(env)?.id).toBe("recent");
    const settings = SettingsSchema.parse({ agents: { includeSubagents: true } });
    expect(
      radialTarget(
        environment(
          [
            agent({ id: "old", activityAt: 10 }),
            agent({ id: "child", activityAt: 50, parentAgentId: "old" }),
          ],
          {
            settings,
          },
        ).env,
      )?.id,
    ).toBe("child");
  });

  it("does not fall back from a selected workspace without agents", () => {
    const { env } = environment([agent({ id: "a", workspaceId: "v" })], {
      workspaces: [workspace({ id: "w" }), workspace({ id: "v" })],
      selected: "w",
    });
    expect(radialTarget(env)).toBeNull();
  });
});

describe("slotBlocker", () => {
  it("lets every default slot act on a running agent with a pending request and history", () => {
    const { env } = busyWithHistory();
    expect(DEFAULT_SETTINGS.radialMenu.slots.map((each) => slotBlocker(each, env))).toEqual(
      Array(8).fill(null),
    );
  });

  it("dims approve and deny without a request of the target, even when another agent has one", () => {
    const { env } = environment(
      [
        agent({ id: "a", title: "Mine", workspaceId: "w", status: "running" }),
        agent({ id: "b", workspaceId: "v", pendingPermissions: [permission()] }),
      ],
      { workspaces: [workspace({ id: "w" }), workspace({ id: "v" })], selected: "w" },
    );
    expect(slotBlocker(slot({ action: "approvePermission" }), env)).toBe(
      "Mine has no pending request",
    );
    expect(slotBlocker(slot({ action: "denyPermission" }), env)).toBe(
      "Mine has no pending request",
    );
  });

  it("dims stop when the target is not running", () => {
    expect(slotBlocker(slot({ action: "stopAgent" }), busy({ status: "idle" }).env)).toBe(
      "Fix the build is not running",
    );
    expect(slotBlocker(slot({ action: "stopAgent" }), busy({ status: "initializing" }).env)).toBe(
      null,
    );
  });

  it("dims every slot that acts on an agent when there is no target", () => {
    const { env } = environment([agent({ id: "a", workspaceId: "w" })], {
      workspaces: [workspace({ id: "w" })],
      settings: SettingsSchema.parse({ targets: { fallback: "none" } }),
    });
    for (const action of [
      "approvePermission",
      "denyPermission",
      "stopAgent",
      "sendPrompt",
      "thinkingUp",
    ] as const) {
      expect(slotBlocker(slot({ action, text: "Go." }), env)).toBe("no agent is selected");
    }
    expect(slotBlocker(slot({ action: "openSelectedWorkspace" }), env)).toBe(
      "no workspace is selected",
    );
    // Actions that need no agent still act.
    expect(slotBlocker(slot({ action: "jumpToBottom" }), env)).toBeNull();
    expect(slotBlocker(slot({ action: "newAgent" }), env)).toBeNull();
  });

  it("dims an empty slot, a prompt without text, and moves with nowhere to go", () => {
    const { env } = busy({ pendingPermissions: [] });
    expect(slotBlocker(slot({ action: "none" }), env)).toBe("the slot has no action");
    expect(slotBlocker(slot({ action: "sendPrompt", text: "  " }), env)).toBe(
      "the slot has no prompt",
    );
    expect(slotBlocker(slot({ action: "nextActionableAgent" }), env)).toBe("no agent needs action");
    expect(slotBlocker(slot({ action: "nextStuckWorkspace" }), env)).toBe(
      "no workspace needs input",
    );
    expect(slotBlocker(slot({ action: "selectNextWorkspace" }), env)).toBe(
      "no workspaces are on the keys",
    );
    expect(slotBlocker(slot({ action: "navigateBack" }), env)).toBe(
      "no earlier place in the keypad's history",
    );
    expect(slotBlocker(slot({ action: "navigateForward" }), env)).toBe(
      "no later place in the keypad's history",
    );
    expect(slotBlocker(slot({ action: "previousWorkspace" }), env)).toBe(
      "there is no other workspace",
    );
    expect(slotBlocker(slot({ action: "nextProject" }), env)).toBe("there is no other project");
    expect(slotBlocker(slot({ action: "nextActionableAgent" }), busy().env)).toBeNull();
  });
});

describe("radialMenuCommand", () => {
  it("sends the slots with their enabled states, the target's name, and Paseo's bundle ID", () => {
    const { env } = busy({ status: "idle", pendingPermissions: [] });
    const command = radialMenuCommand(env);
    expect(command).toMatchObject({
      type: "setRadialMenu",
      target: "Fix the build",
      bundleID: "sh.paseo.desktop",
    });
    if (command.type !== "setRadialMenu") throw new Error("expected setRadialMenu");
    expect(command.slots.map((each) => each.enabled)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(command.slots[0]).toEqual({
      icon: "arrow.uturn.backward.circle",
      label: "Back",
      enabled: false,
    });
    expect(command.slots[6]).toEqual({
      icon: "stop.circle",
      label: "Stop",
      color: "#FF9500",
      enabled: false,
    });
    // A slot without a color leaves it out, so that the app uses its default.
    expect(command.slots[1]).toEqual({ icon: "testtube.2", label: "Test", enabled: true });
  });

  it("names no target without a selected workspace", () => {
    const command = radialMenuCommand(environment([]).env);
    expect(command).toMatchObject({ type: "setRadialMenu", target: null });
  });

  it("clears the menu when it is off", () => {
    const settings = SettingsSchema.parse({ radialMenu: { enabled: false } });
    expect(radialMenuCommand(environment([], { settings }).env)).toEqual({
      type: "clearRadialMenu",
    });
  });
});

describe("planRadialSlot", () => {
  it("runs each default slot's action on the target", async () => {
    const results: string[] = [];
    for (const index of [0, 4, 1, 2, 3, 5, 7, 6]) {
      const { env, recorded } = busyWithHistory();
      const result = await runPlan(planRadialSlot(index, env), env);
      expect(result?.ok).toBe(true);
      results.push(...recorded.calls);
    }
    expect(results).toEqual([
      "open a",
      "open a",
      "prompt a Run the tests and fix any failures",
      "prompt a Continue",
      "prompt a Commit this work",
      "prompt a Review your diff for bugs",
      "prompt a Summarize where things stand and what's left",
      "stop a",
    ]);
  });

  it("goes back and forward through the keypad's history", async () => {
    const { env, recorded } = busyWithHistory();
    await runPlan(planRadialSlot(0, env), env);
    expect(recorded.history.current()?.agentId).toBe("earlier");
    await runPlan(planRadialSlot(4, env), env);
    await runPlan(planRadialSlot(4, env), env);
    expect(recorded.history.current()?.agentId).toBe("later");
    expect(recorded.calls).toEqual(["open a", "open a", "open a"]);
  });

  it("skips a slot that can no longer act, and does nothing", async () => {
    const { env, recorded } = busy({ pendingPermissions: [] });
    const result = await runPlan(planRadialSlot(0, env), env);
    expect(result).toEqual({
      action: "navigateBack",
      ok: false,
      message: "Skipped Back (Up): no earlier place in the keypad's history",
    });
    expect(recorded.calls).toEqual([]);
  });

  it("checks again before it runs that the agent is still there", async () => {
    const { env, agents, recorded } = busy();
    const plan = planRadialSlot(2, env);
    agents.splice(0);
    const result = await runPlan(plan, env);
    expect(result).toMatchObject({
      ok: false,
      message: "Skipped: Fix the build is no longer available",
    });
    expect(recorded.calls).toEqual([]);
  });

  it("runs a slot bound to an action that needs no agent", async () => {
    const slots = DEFAULT_SETTINGS.radialMenu.slots.map((each, index) =>
      index === 3 ? { ...each, action: "jumpToBottom" as const } : each,
    );
    const settings = SettingsSchema.parse({ radialMenu: { slots } });
    const { env, recorded } = environment([], { settings });
    await runPlan(planRadialSlot(3, env), env);
    expect(recorded.calls).toEqual(["edge bottom"]);
  });

  it("does nothing while the menu is off", async () => {
    const settings = SettingsSchema.parse({ radialMenu: { enabled: false } });
    const { env, recorded } = environment([], { settings });
    expect(await runPlan(planRadialSlot(2, env), env)).toMatchObject({
      ok: false,
      message: "The radial menu is off",
    });
    expect(recorded.calls).toEqual([]);
  });
});

describe("radial picks from the bridge", () => {
  it("parses a pick and resolves it to its slot", () => {
    const parsed = parseAppLine('{"type":"input","input":{"kind":"radial","slot":6}}');
    if (parsed.kind !== "message" || parsed.message.type !== "input") {
      throw new Error("expected an input message");
    }
    expect(new InputMapper().resolve(parsed.message.input)).toEqual({
      kind: "radialSlot",
      slot: 6,
    });
    expect(describeInput(parsed.message.input)).toBe("radial menu left");
  });

  it("refuses a slot outside 0 to 7", () => {
    expect(parseAppLine('{"type":"input","input":{"kind":"radial","slot":8}}').kind).toBe(
      "malformed",
    );
    expect(parseAppLine('{"type":"input","input":{"kind":"radial","slot":-1}}').kind).toBe(
      "malformed",
    );
  });
});
