import { describe, expect, it } from "vite-plus/test";
import {
  cycleSelection,
  meterKeys,
  nextStuckWorkspace,
  permissionResponse,
  navigationBlocker,
  permissionTarget,
  planTopKey,
  planTrigger,
  planWorkspaceKey,
  runPlan,
  stepThinking,
  stuckWorkspaces,
  type ActionEnvironment,
  type ThinkingChoices,
} from "../server/actions";
import type { AgentInfo } from "../server/agents";
import type { ActionTrigger, Gesture } from "../server/input-map";
import type { Slots } from "../server/slots";
import { SettingsSchema } from "../shared/settings";
import { agent, CLAUDE_MODELS, environment, permission, workspace } from "./fixtures";

describe("stuckWorkspaces", () => {
  const ws = (id: string) => workspace({ id });
  const asking = (id: string, workspaceId: string, attentionAt: number) =>
    agent({ id, workspaceId, pendingPermissions: [permission()], attentionAt });

  it("lists workspaces with an agent that needs input, the longest waiting first", () => {
    const agents = [
      asking("late", "b", 30),
      asking("early", "a", 20),
      agent({
        id: "question",
        workspaceId: "c",
        requiresAttention: true,
        attentionReason: "permission",
        attentionAt: 10,
      }),
      agent({ id: "done", workspaceId: "d", requiresAttention: true, attentionReason: "finished" }),
      agent({ id: "broken", workspaceId: "e", status: "error" }),
      asking("homeless", "nowhere", 1),
    ];
    const stuck = stuckWorkspaces(["a", "b", "c", "d", "e"].map(ws), agents);
    expect(stuck.map((entry) => [entry.workspace.id, entry.agent.id])).toEqual([
      ["c", "question"],
      ["a", "early"],
      ["b", "late"],
    ]);
  });

  it("dates a workspace by its agent that has waited longest, and opens that agent", () => {
    const agents = [
      asking("newer", "a", 50),
      asking("older", "a", 5),
      agent({ id: "recent", workspaceId: "a", activityAt: 900 }),
      asking("other", "b", 10),
    ];
    const stuck = stuckWorkspaces([ws("a"), ws("b")], agents);
    expect(stuck.map((entry) => [entry.workspace.id, entry.agent.id, entry.waitingSince])).toEqual([
      ["a", "older", 5],
      ["b", "other", 10],
    ]);
  });

  it("cycles from the workspace after the current one, else from the longest waiting", () => {
    const workspaces = ["a", "b", "c"].map(ws);
    const agents = [asking("x", "a", 1), asking("y", "b", 2), asking("z", "c", 3)];
    expect(nextStuckWorkspace(workspaces, agents, null)?.workspace.id).toBe("a");
    expect(nextStuckWorkspace(workspaces, agents, "a")?.workspace.id).toBe("b");
    expect(nextStuckWorkspace(workspaces, agents, "c")?.workspace.id).toBe("a");
    expect(nextStuckWorkspace(workspaces, agents, "elsewhere")?.workspace.id).toBe("a");
    expect(nextStuckWorkspace(workspaces, [agent({ workspaceId: "a" })], null)).toBeNull();
  });
});

describe("permissionTarget", () => {
  const older = permission({ id: "older" });
  const newer = permission({ id: "newer" });
  const selectedRequest = permission({ id: "mine" });
  const seen: Record<string, number> = { older: 1, newer: 2, mine: 3 };
  const seenAt = (_agentId: string, requestId: string) => seen[requestId] ?? Infinity;

  it("prefers the preferred agent's request", () => {
    const agents = [
      agent({ id: "a", pendingPermissions: [older] }),
      agent({ id: "b", pendingPermissions: [selectedRequest] }),
    ];
    expect(permissionTarget(agents, "b", seenAt)?.request.id).toBe("mine");
  });

  it("otherwise takes the oldest pending request", () => {
    const agents = [
      agent({ id: "a", pendingPermissions: [newer] }),
      agent({ id: "b", pendingPermissions: [older] }),
      agent({ id: "c" }),
    ];
    expect(permissionTarget(agents, "c", seenAt)).toMatchObject({
      agent: { id: "b" },
      request: { id: "older" },
    });
  });

  it("returns null without pending requests", () => {
    expect(permissionTarget([agent()], null, seenAt)).toBeNull();
  });
});

describe("permissionResponse", () => {
  it("uses the request's own actions when it has them", () => {
    const request = permission({ allowActionId: "always", denyActionId: "reject" });
    expect(permissionResponse(request, true)).toEqual({
      behavior: "allow",
      selectedActionId: "always",
    });
    expect(permissionResponse(request, false)).toEqual({
      behavior: "deny",
      selectedActionId: "reject",
    });
  });

  it("answers plainly otherwise", () => {
    expect(permissionResponse(permission(), true)).toEqual({ behavior: "allow" });
    expect(permissionResponse(permission(), false)).toEqual({ behavior: "deny" });
  });
});

describe("cycleSelection", () => {
  const slots: Slots = ["a", null, "b", "c", null, null];

  it("steps through occupied keys and wraps", () => {
    expect(cycleSelection(slots, "a", 1)).toBe("b");
    expect(cycleSelection(slots, "c", 1)).toBe("a");
    expect(cycleSelection(slots, "a", -1)).toBe("c");
  });

  it("starts at either end without a selection", () => {
    expect(cycleSelection(slots, null, 1)).toBe("a");
    expect(cycleSelection(slots, "elsewhere", -1)).toBe("c");
  });

  it("returns null without workspaces", () => {
    expect(cycleSelection([null, null, null, null, null, null], null, 1)).toBeNull();
  });
});

describe("meterKeys", () => {
  it("lights one key for each level when the model has six options", () => {
    expect([0, 1, 2, 3, 4, 5].map((position) => meterKeys(position, 6))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("spreads fewer or more options over the six keys, lighting at least one", () => {
    expect([0, 1, 2].map((position) => meterKeys(position, 3))).toEqual([2, 4, 6]);
    expect([0, 1, 2, 3].map((position) => meterKeys(position, 4))).toEqual([2, 3, 5, 6]);
    expect(meterKeys(0, 12)).toBe(1);
    expect(meterKeys(11, 12)).toBe(6);
    expect(meterKeys(0, 1)).toBe(6);
  });

  it("lights nothing for an unknown level or a model without options", () => {
    expect(meterKeys(-1, 3)).toBe(0);
    expect(meterKeys(0, 0)).toBe(0);
  });
});

describe("stepThinking", () => {
  const choices: ThinkingChoices = {
    options: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    current: "medium",
  };

  it("moves up and down the provider's order", () => {
    expect(stepThinking(choices, 1)).toBe("high");
    expect(stepThinking(choices, -1)).toBe("low");
  });

  it("stops at the ends", () => {
    expect(stepThinking({ ...choices, current: "high" }, 1)).toBeNull();
    expect(stepThinking({ ...choices, current: "low" }, -1)).toBeNull();
  });

  it("starts at an end when the current option is unknown", () => {
    expect(stepThinking({ ...choices, current: null }, 1)).toBe("low");
    expect(stepThinking({ ...choices, current: "other" }, -1)).toBe("high");
  });

  it("moves several steps at once and stops at the end", () => {
    const six: ThinkingChoices = {
      options: CLAUDE_MODELS[0]!.thinkingOptions,
      current: "high",
    };
    expect(stepThinking(six, 1, 2)).toBe("max");
    expect(stepThinking(six, 1, 10)).toBe("ultracode");
    expect(stepThinking(six, -1, 10)).toBe("low");
    expect(stepThinking({ ...six, current: "ultracode" }, 1, 3)).toBeNull();
    // From an option that the model does not have, such as Opus 5's "off" on Opus 5.5.
    expect(stepThinking({ ...six, current: "off" }, 1, 2)).toBe("medium");
    expect(stepThinking({ ...six, current: "off" }, -1, 2)).toBe("max");
  });
});

const runTrigger = (trigger: ActionTrigger, env: ActionEnvironment, gesture?: Gesture) =>
  runPlan(planTrigger(trigger, env, gesture), env);

type RunAction = Extract<ActionTrigger, { kind: "run" }>["action"];

const run = (action: RunAction, env: ActionEnvironment, text = "") =>
  runTrigger({ kind: "run", action, text }, env);

const pressWorkspaceKey = (slot: number, env: ActionEnvironment) =>
  runPlan(planWorkspaceKey(slot, env), env);

const talkGesture = (): Gesture => ({
  binding: { action: "pushToTalk", text: "" },
  started: false,
});

describe("runTrigger", () => {
  it("sends Cmd+D on press and release, and Return after the delay when configured", async () => {
    const plain = environment([]);
    const gesture = talkGesture();
    await runTrigger({ kind: "talk", mode: "start" }, plain.env, gesture);
    await runTrigger({ kind: "talk", mode: "stop" }, plain.env, gesture);
    expect(plain.recorded.calls).toEqual(["shortcut cmd+d", "shortcut cmd+d"]);

    const settings = SettingsSchema.parse({
      pushToTalk: { sendReturnOnRelease: true, returnDelayMs: 250 },
    });
    const sending = environment([], { settings });
    const held = talkGesture();
    await runTrigger({ kind: "talk", mode: "start" }, sending.env, held);
    const result = await runTrigger({ kind: "talk", mode: "stop" }, sending.env, held);
    expect(sending.recorded.calls).toEqual([
      "shortcut cmd+d",
      "shortcut cmd+d",
      "sleep 250",
      "shortcut return",
    ]);
    expect(result?.ok).toBe(true);
  });

  it("stops dictation only for a gesture whose start succeeded", async () => {
    const { env, recorded } = environment([]);
    const unstarted = await runTrigger({ kind: "talk", mode: "stop" }, env, talkGesture());
    expect(unstarted).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not start"),
    });
    const orphan = await runTrigger({ kind: "talk", mode: "stop" }, env);
    expect(orphan?.ok).toBe(false);
    expect(recorded.calls).toEqual([]);

    const refusing = environment([]);
    refusing.env.sendShortcut = async () => {
      throw new Error("Accessibility permission is missing");
    };
    const gesture = talkGesture();
    await expect(
      runTrigger({ kind: "talk", mode: "start" }, refusing.env, gesture),
    ).rejects.toThrow("Accessibility");
    expect(gesture.started).toBe(false);
  });

  it("toggles voice mode with Cmd+Shift+D", async () => {
    const { env, recorded } = environment([]);
    await run("toggleVoiceMode", env);
    expect(recorded.calls).toEqual(["shortcut cmd+shift+d"]);
  });

  it("opens the waiting agent of the next workspace that needs input", async () => {
    const waiting = (id: string, workspaceId: string, attentionAt: number) =>
      agent({ id, workspaceId, pendingPermissions: [permission()], attentionAt });
    const { env, recorded } = environment(
      [waiting("x", "a", 1), waiting("y", "b", 2), agent({ id: "q", workspaceId: "c" })],
      { workspaces: ["a", "b", "c"].map((id) => workspace({ id })), selected: "c" },
    );
    expect(await run("nextStuckWorkspace", env)).toMatchObject({ ok: true });
    expect(await run("nextStuckWorkspace", env)).toMatchObject({ ok: true });
    expect(await run("nextStuckWorkspace", env)).toMatchObject({ ok: true });
    expect(recorded.calls).toEqual(["open x", "open y", "open x"]);
    expect(recorded.selected).toBe("a");
    expect(recorded.history.list().map((place) => place.workspaceId)).toEqual(["a", "b", "a"]);
  });

  it("does nothing when no workspace needs input, and says so", async () => {
    const { env, recorded } = environment([agent({ id: "q", workspaceId: "a" })], {
      workspaces: [workspace({ id: "a" })],
      selected: "a",
    });
    expect(await run("nextStuckWorkspace", env)).toEqual({
      action: "nextStuckWorkspace",
      ok: true,
      message: "No workspace needs input",
    });
    expect(recorded.calls).toEqual([]);
    expect(recorded.selected).toBe("a");
  });

  it("goes back through the workspaces that the keypad opened", async () => {
    const agents = ["a", "b", "c"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env, recorded } = environment(agents, {
      workspaces: ["a", "b", "c"].map((id) => workspace({ id })),
      slots: ["a", "b", "c", null, null, null],
    });
    await pressWorkspaceKey(0, env);
    await pressWorkspaceKey(1, env);
    await pressWorkspaceKey(2, env);
    recorded.calls.length = 0;
    await run("navigateBack", env);
    expect(recorded.selected).toBe("b");
    await run("navigateBack", env);
    expect(await run("navigateBack", env)).toMatchObject({
      ok: true,
      message: "No earlier place in the keypad's history",
    });
    expect(recorded.calls).toEqual(["open agent-b", "open agent-a"]);
    expect(recorded.selected).toBe("a");
  });

  it("goes forward again after going back, until a new place drops the places ahead", async () => {
    const agents = ["a", "b", "c"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env, recorded } = environment(agents, {
      workspaces: ["a", "b", "c"].map((id) => workspace({ id })),
      slots: ["a", "b", "c", null, null, null],
    });
    for (const slot of [0, 1, 2]) await pressWorkspaceKey(slot, env);
    expect(await run("navigateForward", env)).toMatchObject({
      ok: true,
      message: "No later place in the keypad's history",
    });
    await run("navigateBack", env);
    await run("navigateBack", env);
    recorded.calls.length = 0;
    await run("navigateForward", env);
    expect(recorded.calls).toEqual(["open agent-b"]);
    expect(recorded.selected).toBe("b");
    // Going back and forward moves in the history without recording.
    expect(recorded.history.list().map((place) => place.workspaceId)).toEqual(["a", "b", "c"]);
    await pressWorkspaceKey(0, env);
    expect(recorded.history.list().map((place) => place.workspaceId)).toEqual(["a", "b", "a"]);
    expect(await run("navigateForward", env)).toMatchObject({
      message: "No later place in the keypad's history",
    });
  });

  it("goes back to the agent that it opened, not only to its workspace", async () => {
    const first = agent({ id: "first", workspaceId: "w", activityAt: 1 });
    const second = agent({ id: "second", workspaceId: "w", activityAt: 2 });
    const { env, recorded } = environment([first, second], {
      workspaces: [workspace({ id: "w" })],
      agentSlots: ["second", "first", null, null, null, null],
      settings: SettingsSchema.parse({ topKeys: { mode: "recentAgents", openOnSingleTap: true } }),
    });
    await runPlan(planTopKey(1, env, true), env);
    await runPlan(planTopKey(0, env, true), env);
    recorded.calls.length = 0;
    await run("navigateBack", env);
    expect(recorded.calls).toEqual(["open first"]);
  });

  it("skips archived workspaces and workspaces without agents when going back", async () => {
    const agents = ["a", "b", "c"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env, recorded, workspaces } = environment(agents, {
      workspaces: ["a", "b", "c"].map((id) => workspace({ id })),
      slots: ["a", "b", "c", null, null, null],
    });
    for (const slot of [0, 1, 2]) await pressWorkspaceKey(slot, env);
    workspaces.splice(1, 1);
    recorded.calls.length = 0;
    await run("navigateBack", env);
    expect(recorded.calls).toEqual(["open agent-a"]);
  });

  it("records the workspaces of agents that the keypad opens from anywhere", async () => {
    const unread = agent({
      id: "u",
      workspaceId: "ws",
      requiresAttention: true,
      attentionReason: "finished",
    });
    const { env, recorded } = environment([unread], { workspaces: [workspace({ id: "ws" })] });
    await run("nextActionableAgent", env);
    expect(recorded.history.list()).toEqual([{ workspaceId: "ws", agentId: "u" }]);
  });

  it("sends Paseo's shortcuts for the previous and next workspace", async () => {
    const { env, recorded } = environment([], { selected: "a" });
    await run("previousWorkspace", env);
    await run("nextWorkspace", env);
    expect(recorded.calls).toEqual(["shortcut cmd+[", "shortcut cmd+]"]);
    expect(recorded.selected).toBe("a");
  });

  it("opens the next agent that needs action and selects its workspace", async () => {
    const waiting = agent({
      id: "w",
      workspaceId: "ws",
      requiresAttention: true,
      attentionReason: "finished",
    });
    const { env, recorded } = environment([agent(), waiting], {
      workspaces: [workspace({ id: "ws" })],
    });
    expect(await run("nextActionableAgent", env)).toEqual({
      action: "nextActionableAgent",
      ok: true,
      message: "Opened w",
    });
    expect(recorded.calls).toEqual(["open w"]);
    expect(recorded.selected).toBe("ws");
    expect(recorded.opened).toBe("w");
  });

  it("walks through every agent that needs action when opening clears nothing", async () => {
    const agents = [
      agent({ id: "asking", pendingPermissions: [permission()], attentionAt: 30 }),
      agent({ id: "failed", status: "error", activityAt: 20 }),
      agent({ id: "done", requiresAttention: true, attentionReason: "finished", attentionAt: 10 }),
      agent({ id: "quiet" }),
    ];
    const { env, recorded } = environment(agents);
    for (let press = 0; press < 6; press += 1) await run("nextActionableAgent", env);
    expect(recorded.calls).toEqual([
      "open done",
      "open failed",
      "open asking",
      "open done",
      "open failed",
      "open asking",
    ]);
  });

  it("moves on when opening an agent clears its attention", async () => {
    const unread = (id: string, attentionAt: number) =>
      agent({ id, requiresAttention: true, attentionReason: "finished", attentionAt });
    const { env, recorded, agents } = environment([unread("a", 1), unread("b", 2)]);
    env.openAgent = async (id) => {
      recorded.calls.push(`open ${id}`);
      const index = agents.findIndex((each) => each.id === id);
      const opened = agents[index];
      if (opened) agents[index] = { ...opened, requiresAttention: false, attentionReason: null };
    };
    await run("nextActionableAgent", env);
    await run("nextActionableAgent", env);
    expect(await run("nextActionableAgent", env)).toMatchObject({
      ok: true,
      message: "No agent needs action",
    });
    expect(recorded.calls).toEqual(["open a", "open b"]);
  });

  it("does nothing when no agent needs action, and says so", async () => {
    const { env, recorded } = environment([agent({ id: "q", workspaceId: "a" })], {
      workspaces: [workspace({ id: "a" })],
      selected: "a",
      opened: "q",
    });
    expect(await run("nextActionableAgent", env)).toEqual({
      action: "nextActionableAgent",
      ok: true,
      message: "No agent needs action",
    });
    expect(recorded.calls).toEqual([]);
    expect(recorded.selected).toBe("a");
  });

  it("skips the agent that the keypad opened last while another agent needs action", async () => {
    const failed = (id: string, activityAt: number) =>
      agent({ id, workspaceId: id, status: "error", activityAt });
    const { env, recorded } = environment([failed("old", 1), failed("new", 2)], {
      workspaces: [workspace({ id: "old" }), workspace({ id: "new" })],
      slots: ["old", "new", null, null, null, null],
    });
    await pressWorkspaceKey(0, env);
    recorded.calls.length = 0;
    await run("nextActionableAgent", env);
    expect(recorded.calls).toEqual(["open new"]);
  });

  it("opens the only agent that needs action again, and says so", async () => {
    const { env, recorded } = environment([agent({ id: "only", status: "error" })]);
    await run("nextActionableAgent", env);
    expect(await run("nextActionableAgent", env)).toMatchObject({
      ok: true,
      message: "Opened only again; no other agent needs action",
    });
    expect(recorded.calls).toEqual(["open only", "open only"]);
  });

  it("skips a planned agent that no longer needs action when its turn comes", async () => {
    const { env, recorded, agents } = environment([
      agent({ id: "w", requiresAttention: true, attentionReason: "finished" }),
    ]);
    const plan = planTrigger({ kind: "run", action: "nextActionableAgent", text: "" }, env);
    agents[0] = agent({ id: "w" });
    expect(await runPlan(plan, env)).toMatchObject({
      ok: false,
      message: "Skipped: w no longer needs action",
    });
    expect(recorded.calls).toEqual([]);
  });

  it("sends Return to submit", async () => {
    const { env, recorded } = environment([]);
    expect(await run("submit", env)).toEqual({
      action: "submit",
      ok: true,
      message: "Sent Return to Paseo",
    });
    expect(recorded.calls).toEqual(["shortcut return"]);
  });

  it("stops held push to talk before it submits, and the release then sends nothing", async () => {
    const settings = SettingsSchema.parse({ pushToTalk: { returnDelayMs: 300 } });
    const { env, recorded } = environment([], { settings });
    const gesture = talkGesture();
    await runTrigger({ kind: "talk", mode: "start" }, env, gesture);
    expect(await run("submit", env)).toMatchObject({
      ok: true,
      message: "Stopped dictation and sent it",
    });
    expect(await runTrigger({ kind: "talk", mode: "stop" }, env, gesture)).toBeNull();
    expect(recorded.calls).toEqual([
      "shortcut cmd+d",
      "shortcut cmd+d",
      "sleep 300",
      "shortcut return",
    ]);
    expect(recorded.dictating).toBe(false);
  });

  it("stops toggled dictation before it submits", async () => {
    const { env, recorded } = environment([]);
    await runTrigger({ kind: "talk", mode: "toggle" }, env);
    await run("submit", env);
    await run("submit", env);
    expect(recorded.calls).toEqual([
      "shortcut cmd+d",
      "shortcut cmd+d",
      "sleep 600",
      "shortcut return",
      "shortcut return",
    ]);
  });

  it("never sends Cmd+Shift+D from push to talk or submit", async () => {
    const settings = SettingsSchema.parse({ pushToTalk: { sendReturnOnRelease: true } });
    const { env, recorded } = environment([], { settings });
    const gesture = talkGesture();
    await runTrigger({ kind: "talk", mode: "start" }, env, gesture);
    await runTrigger({ kind: "talk", mode: "stop" }, env, gesture);
    await runTrigger({ kind: "talk", mode: "toggle" }, env);
    await runTrigger({ kind: "talk", mode: "toggle" }, env);
    await run("submit", env);
    const shortcuts = recorded.calls.filter((call) => call.startsWith("shortcut "));
    expect(new Set(shortcuts)).toEqual(new Set(["shortcut cmd+d", "shortcut return"]));
  });

  it("approves and denies tool requests, and opens the agent for a question", async () => {
    const tool = agent({ id: "t", pendingPermissions: [permission({ id: "r1" })] });
    const approve = environment([tool]);
    await run("approvePermission", approve.env);
    expect(approve.recorded.calls).toEqual(["allow t r1"]);

    const deny = environment([tool]);
    await run("denyPermission", deny.env);
    expect(deny.recorded.calls).toEqual(["deny t r1"]);

    const question = agent({ id: "q", pendingPermissions: [permission({ kind: "question" })] });
    const ask = environment([question]);
    const result = await run("approvePermission", ask.env);
    expect(ask.recorded.calls).toEqual(["open q"]);
    expect(result?.message).toContain("question");
  });

  it("approves the selected workspace's request before an older one elsewhere", async () => {
    const older = agent({
      id: "elsewhere",
      workspaceId: "other",
      pendingPermissions: [permission({ id: "old" })],
    });
    const mine = agent({
      id: "mine",
      workspaceId: "ws",
      pendingPermissions: [permission({ id: "new" })],
    });
    const { env, recorded } = environment([older, mine], {
      workspaces: [workspace({ id: "ws" }), workspace({ id: "other" })],
      selected: "ws",
    });
    env.permissionSeenAt = (_agentId, requestId) => (requestId === "old" ? 1 : 2);
    await run("approvePermission", env);
    expect(recorded.calls).toEqual(["allow mine new"]);
  });

  it("falls back to the oldest pending request and selects its workspace", async () => {
    const older = agent({
      id: "elsewhere",
      workspaceId: "other",
      pendingPermissions: [permission({ id: "old" })],
    });
    const newer = agent({ id: "loose", pendingPermissions: [permission({ id: "new" })] });
    const quiet = agent({ id: "quiet", workspaceId: "ws" });
    const { env, recorded } = environment([older, newer, quiet], {
      workspaces: [workspace({ id: "ws" }), workspace({ id: "other" })],
      selected: "ws",
    });
    env.permissionSeenAt = (_agentId, requestId) => (requestId === "old" ? 1 : 2);
    await run("denyPermission", env);
    expect(recorded.calls).toEqual(["deny elsewhere old"]);
    expect(recorded.selected).toBe("other");
  });

  it("does nothing to agents when no permission is pending", async () => {
    const { env, recorded } = environment([agent()]);
    const result = await run("approvePermission", env);
    expect(recorded.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, message: "No pending permission requests" });
  });

  it("acts only on the selected workspace's agent when the fallback is off", async () => {
    const target = agent({ id: "s", workspaceId: "ws" });
    const none = environment([target], {
      workspaces: [workspace({ id: "ws" })],
      settings: SettingsSchema.parse({ targets: { fallback: "none" } }),
    });
    for (const action of ["stopAgent", "openSelectedWorkspace", "sendPrompt"] as const) {
      const result = await run(action, none.env, "Go");
      expect(result).toMatchObject({ ok: false, message: "No workspace is selected" });
    }
    expect(none.recorded.calls).toEqual([]);

    const { env, recorded } = environment([target], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    await run("stopAgent", env);
    await run("openSelectedWorkspace", env);
    await run("sendPrompt", env, "Continue.");
    expect(recorded.calls).toEqual(["stop s", "open s", "prompt s Continue."]);
  });

  it("acts on the fallback agent without a selected workspace, and selects nothing", async () => {
    const recent = agent({ id: "recent", workspaceId: "w", activityAt: 90 });
    const asking = agent({
      id: "asking",
      workspaceId: "v",
      activityAt: 10,
      pendingPermissions: [permission({ id: "r" })],
    });
    const workspaces = [workspace({ id: "w" }), workspace({ id: "v" })];
    const { env, recorded } = environment([recent, asking], { workspaces });
    await run("sendPrompt", env, "Continue");
    await run("stopAgent", env);
    await run("approvePermission", env);
    expect(recorded.calls).toEqual(["prompt asking Continue", "stop asking", "allow asking r"]);
    // Approve selects the workspace of the agent that it answered, as it always has.
    recorded.selected = null;
    expect(await run("openSelectedWorkspace", env)).toMatchObject({
      ok: false,
      message: "No workspace is selected",
    });

    const idle = environment([recent], { workspaces });
    await run("sendPrompt", idle.env, "Go");
    expect(idle.recorded.calls).toEqual(["prompt recent Go"]);
    expect(idle.recorded.selected).toBeNull();

    const empty = environment([], { workspaces });
    expect(await run("sendPrompt", empty.env, "Go")).toMatchObject({
      ok: false,
      message: "No workspace is selected, and no agent can stand in for it",
    });
  });

  it("chooses the workspace's agent that needs input, then failed, then the most recent", async () => {
    const recent = agent({ id: "recent", workspaceId: "ws", activityAt: 900 });
    const broken = agent({ id: "broken", workspaceId: "ws", status: "error", activityAt: 10 });
    const asking = agent({
      id: "asking",
      workspaceId: "ws",
      pendingPermissions: [permission({ id: "r" })],
      activityAt: 5,
    });
    const workspaces = [workspace({ id: "ws" })];
    const all = environment([recent, broken, asking], { workspaces, selected: "ws" });
    await run("stopAgent", all.env);
    const failedFirst = environment([recent, broken], { workspaces, selected: "ws" });
    await run("stopAgent", failedFirst.env);
    const recentOnly = environment([recent], { workspaces, selected: "ws" });
    await run("stopAgent", recentOnly.env);
    expect([all, failedFirst, recentOnly].map((entry) => entry.recorded.calls)).toEqual([
      ["stop asking"],
      ["stop broken"],
      ["stop recent"],
    ]);
  });

  it("reports a selected workspace without agents", async () => {
    const { env, recorded } = environment([agent({ workspaceId: "other" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    expect(await run("stopAgent", env)).toMatchObject({ ok: false, message: "ws has no agents" });
    expect(await run("openSelectedWorkspace", env)).toMatchObject({
      ok: true,
      message: "Selected ws, which has no agents",
    });
    expect(recorded.calls).toEqual([]);
  });

  it("does nothing for an empty prompt, with or without a selected workspace", async () => {
    const { env, recorded } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    expect(await run("sendPrompt", env, "  ")).toEqual({
      action: "sendPrompt",
      ok: true,
      message: "No prompt is set for this input",
    });
    const unselected = environment([]);
    expect(await run("sendPrompt", unselected.env, "")).toMatchObject({ ok: true });
    expect(recorded.calls).toEqual([]);
    expect(unselected.recorded.calls).toEqual([]);
  });

  it("sends a joystick direction's prompt to the selected workspace's agent", async () => {
    const { env, recorded } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    const binding = SettingsSchema.parse({
      bindings: { joystickUp: { action: "sendPrompt", text: "Continue." } },
    }).bindings.joystickUp;
    await runTrigger({ kind: "run", action: "sendPrompt", text: binding.text }, env);
    expect(recorded.calls).toEqual(["prompt s Continue."]);
  });

  it("scrolls by the configured lines, down for scroll down and up for scroll up", async () => {
    const settings = SettingsSchema.parse({ scroll: { lines: 5 } });
    const { env, recorded } = environment([], { settings });
    expect(await run("scrollDown", env)).toMatchObject({
      ok: true,
      message: "Scrolled down 5 lines",
    });
    expect(await run("scrollUp", env)).toMatchObject({ ok: true, message: "Scrolled up 5 lines" });
    expect(recorded.calls).toEqual(["scroll 5", "scroll -5"]);
    expect(environment([]).env.settings().scroll).toEqual({
      lines: 3,
      fastLines: 15,
      fromTop: 0.4,
    });
  });

  it("scrolls fast by the configured fast lines, in the direction of the plain scroll", async () => {
    const settings = SettingsSchema.parse({ scroll: { lines: 2, fastLines: 20 } });
    const { env, recorded } = environment([], { settings });
    expect(await run("scrollDownFast", env)).toMatchObject({
      action: "scrollDownFast",
      ok: true,
      message: "Scrolled down 20 lines",
    });
    expect(await run("scrollUpFast", env)).toMatchObject({ message: "Scrolled up 20 lines" });
    expect(recorded.calls).toEqual(["scroll 20", "scroll -20"]);
    const plan = planTrigger({ kind: "run", action: "scrollUpFast", text: "" }, env);
    expect(plan.kind === "queue" && plan.planned.scroll).toEqual({ lines: -20 });
  });

  it("jumps to the bottom every time, and ignores repeats while a jump waits or runs", async () => {
    const { env, recorded } = environment([]);
    for (let click = 0; click < 3; click += 1) {
      expect(await run("jumpToBottom", env)).toEqual({
        action: "jumpToBottom",
        ok: true,
        message: "Jumped to the bottom",
      });
    }
    expect(recorded.calls).toEqual(["edge bottom", "edge bottom", "edge bottom"]);
    const plan = planTrigger({ kind: "run", action: "jumpToBottom", text: "" }, env);
    expect(plan.kind === "queue" && plan.planned.ignoreRepeats).toBe(true);
  });

  it("lets a waiting scroll take the lines of later scrolls, and skips a scroll that sums to zero", async () => {
    const { env, recorded } = environment([]);
    const plan = planTrigger({ kind: "run", action: "scrollDown", text: "" }, env);
    if (plan.kind !== "queue" || !plan.planned.scroll) throw new Error("expected a queued scroll");
    plan.planned.scroll.lines += 6;
    expect(await runPlan(plan, env)).toMatchObject({ message: "Scrolled down 9 lines" });
    plan.planned.scroll.lines = 0;
    expect(await runPlan(plan, env)).toBeNull();
    expect(recorded.calls).toEqual(["scroll 9"]);
  });

  it("focuses the composer with Cmd+L and interrupts nothing", async () => {
    const { env, recorded } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    expect(await run("focusComposer", env)).toMatchObject({ ok: true });
    expect(recorded.calls).toEqual(["shortcut cmd+l"]);
  });

  it("steps the thinking option of the selected workspace's agent", async () => {
    const choices: ThinkingChoices = {
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      current: "low",
    };
    const { env, recorded } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
      choices,
    });
    const up = await run("thinkingUp", env);
    expect(recorded.calls).toEqual(["thinking s high", "meter 1/2"]);
    expect(up?.message).toContain("High");
    const down = await run("thinkingDown", env);
    expect(down?.message).toContain("lowest");
    // The meter shows the level even when it cannot move.
    expect(recorded.calls).toEqual(["thinking s high", "meter 1/2", "meter 0/2"]);
  });

  it("moves by every step that a waiting thinking change collected, with one command", async () => {
    const { env, recorded } = environment(
      [agent({ id: "s", workspaceId: "ws", model: "opus", thinkingOptionId: "low" })],
      {
        workspaces: [workspace({ id: "ws" })],
        selected: "ws",
        choices: { options: CLAUDE_MODELS[0]!.thinkingOptions, current: "low" },
      },
    );
    const plan = planTrigger({ kind: "run", action: "thinkingUp", text: "" }, env);
    if (plan.kind !== "queue") throw new Error("expected queued work");
    expect(plan.planned.thinking).toEqual({ agentId: "s", direction: 1, steps: 1 });
    plan.planned.thinking!.steps += 3;
    expect(await runPlan(plan, env)).toMatchObject({ ok: true });
    expect(recorded.calls).toEqual(["thinking s max", "meter 4/6"]);
  });

  it("starts from its last change while the agent's snapshot does not show it yet", async () => {
    const options = CLAUDE_MODELS[0]!.thinkingOptions;
    const { env, recorded, agents } = environment(
      [agent({ id: "s", workspaceId: "ws", thinkingOptionId: "low" })],
      { workspaces: [workspace({ id: "ws" })], selected: "ws" },
    );
    env.thinkingChoices = async (agent) => ({ options, current: agent.thinkingOptionId });
    await run("thinkingUp", env);
    await run("thinkingUp", env);
    expect(recorded.calls.filter((call) => call.startsWith("thinking"))).toEqual([
      "thinking s medium",
      "thinking s high",
    ]);
    // The snapshot catches up with the first change only; the note still applies.
    agents[0] = { ...agents[0]!, thinkingOptionId: "medium" };
    await run("thinkingUp", env);
    expect(recorded.calls.at(-2)).toBe("thinking s xhigh");
    // A change from elsewhere, to an option the keypad never set, ends the note.
    agents[0] = { ...agents[0]!, thinkingOptionId: "max" };
    await run("thinkingDown", env);
    expect(recorded.calls.at(-2)).toBe("thinking s xhigh");
  });

  it("flashes the failure light instead of the meter when the thinking change fails", async () => {
    const { env, recorded } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
      choices: {
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        current: "low",
      },
    });
    env.setThinking = async () => {
      throw new Error("the CLI failed");
    };
    await expect(run("thinkingUp", env)).rejects.toThrow("the CLI failed");
    expect(recorded.calls).toEqual(["failure flash"]);
  });

  it("flashes the failure light when the model is unknown or has no thinking options", async () => {
    const selected = {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    };
    const unknown = environment([agent({ id: "s", workspaceId: "ws", model: "opus" })], selected);
    expect(await run("thinkingUp", unknown.env)).toMatchObject({
      ok: false,
      message: "s's model, opus, is not among the claude models",
    });
    expect(unknown.recorded.calls).toEqual(["failure flash"]);

    const empty = environment([agent({ id: "s", workspaceId: "ws" })], {
      ...selected,
      choices: { options: [], current: null },
    });
    expect(await run("thinkingDown", empty.env)).toMatchObject({
      ok: false,
      message: "s's model has no thinking options",
    });
    expect(empty.recorded.calls).toEqual(["failure flash"]);

    const lookup = environment([agent({ id: "s", workspaceId: "ws" })], selected);
    lookup.env.thinkingChoices = async () => {
      throw new Error("Could not list claude models: offline");
    };
    await expect(run("thinkingUp", lookup.env)).rejects.toThrow("offline");
    expect(lookup.recorded.calls).toEqual(["failure flash"]);
  });

  it("selects workspaces without opening them when cycling", async () => {
    const { env, recorded } = environment(
      [agent({ workspaceId: "a" }), agent({ workspaceId: "b" })],
      {
        workspaces: [workspace({ id: "a" }), workspace({ id: "b" })],
        slots: ["a", "b", null, null, null, null],
        selected: "a",
      },
    );
    expect(await run("selectNextWorkspace", env)).toMatchObject({ message: "Selected b" });
    expect(recorded.selected).toBe("b");
    await run("selectNextWorkspace", env);
    expect(recorded.selected).toBe("a");
    await run("selectPreviousWorkspace", env);
    expect(recorded.selected).toBe("b");
    expect(recorded.calls).toEqual([]);
  });
});

describe("pressWorkspaceKey", () => {
  it("selects the key's workspace and opens its agent", async () => {
    const { env, recorded } = environment(
      [
        agent({ id: "old", workspaceId: "ws", activityAt: 1 }),
        agent({ id: "new", workspaceId: "ws", activityAt: 2 }),
      ],
      { workspaces: [workspace({ id: "ws" })], slots: [null, "ws", null, null, null, null] },
    );
    await pressWorkspaceKey(1, env);
    expect(recorded.selected).toBe("ws");
    expect(recorded.calls).toEqual(["open new"]);
    expect(recorded.opened).toBe("new");
  });

  it("opens the agent that needs input before a more recent one", async () => {
    const { env, recorded } = environment(
      [
        agent({
          id: "asking",
          workspaceId: "ws",
          activityAt: 1,
          pendingPermissions: [permission()],
        }),
        agent({ id: "busy", workspaceId: "ws", activityAt: 9, status: "running" }),
      ],
      { workspaces: [workspace({ id: "ws" })], slots: ["ws", null, null, null, null, null] },
    );
    await pressWorkspaceKey(0, env);
    expect(recorded.calls).toEqual(["open asking"]);
  });

  it("selects a workspace without agents and opens nothing", async () => {
    const { env, recorded } = environment([], {
      workspaces: [workspace({ id: "ws" })],
      slots: ["ws", null, null, null, null, null],
    });
    expect(await pressWorkspaceKey(0, env)).toMatchObject({ ok: true });
    expect(recorded.selected).toBe("ws");
    expect(recorded.calls).toEqual([]);
  });

  it("does nothing for an empty key", async () => {
    const { env, recorded } = environment([]);
    expect(await pressWorkspaceKey(0, env)).toBeNull();
    expect(recorded.calls).toEqual([]);
    expect(recorded.selected).toBeNull();
  });
});

describe("plans", () => {
  it("fix a workspace key's workspace and agent when pressed and skip them if the key changes", async () => {
    const slots: (string | null)[] = ["a", "b", null, null, null, null];
    const { env, recorded } = environment(
      [agent({ id: "x", workspaceId: "a" }), agent({ id: "y", workspaceId: "b" })],
      { workspaces: [workspace({ id: "a" }), workspace({ id: "b" })], slots },
    );
    const plan = planWorkspaceKey(1, env);
    expect(recorded.selected).toBe("b");
    slots[1] = "a";
    slots[0] = null;
    const result = await runPlan(plan, env);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("another workspace"),
    });
    expect(recorded.calls).toEqual([]);
  });

  it("skip opening a workspace whose chosen agent went away", async () => {
    const { env, recorded, agents } = environment([agent({ id: "x", workspaceId: "a" })], {
      workspaces: [workspace({ id: "a" })],
      slots: ["a", null, null, null, null, null],
    });
    const plan = planWorkspaceKey(0, env);
    agents.length = 0;
    agents.push(agent({ id: "replacement", workspaceId: "a" }));
    expect(await runPlan(plan, env)).toMatchObject({ ok: false });
    expect(recorded.calls).toEqual([]);
  });

  it("skip opening a workspace that was archived", async () => {
    const { env, recorded, workspaces } = environment([agent({ id: "x", workspaceId: "a" })], {
      workspaces: [workspace({ id: "a" })],
      selected: "a",
    });
    const plan = planTrigger({ kind: "run", action: "openSelectedWorkspace", text: "" }, env);
    workspaces.length = 0;
    expect(await runPlan(plan, env)).toMatchObject({
      ok: false,
      message: expect.stringContaining("no longer available"),
    });
    expect(recorded.calls).toEqual([]);
  });

  it("answer the request that was pending when pressed, or nothing", async () => {
    const first = permission({ id: "r1" });
    const asking = agent({ id: "a", pendingPermissions: [first] });
    const { env, recorded, agents } = environment([asking]);
    const plan = planTrigger({ kind: "run", action: "approvePermission", text: "" }, env);
    agents[0] = { ...asking, pendingPermissions: [permission({ id: "r2" })] };
    const result = await runPlan(plan, env);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("already answered"),
    });
    expect(recorded.calls).toEqual([]);
  });

  it("skip an action whose agent went away", async () => {
    const { env, recorded, agents } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    const plan = planTrigger({ kind: "run", action: "stopAgent", text: "" }, env);
    agents.length = 0;
    expect(await runPlan(plan, env)).toMatchObject({ ok: false });
    expect(recorded.calls).toEqual([]);
  });

  it("keep the agent chosen at the press even if another agent needs input later", async () => {
    const quiet = agent({ id: "quiet", workspaceId: "ws" });
    const { env, recorded, agents } = environment([quiet], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    const plan = planTrigger({ kind: "run", action: "stopAgent", text: "" }, env);
    agents.push(agent({ id: "asking", workspaceId: "ws", pendingPermissions: [permission()] }));
    await runPlan(plan, env);
    expect(recorded.calls).toEqual(["stop quiet"]);
  });

  it("run nothing after the signal aborts, even mid-action", async () => {
    let finishLookup: (choices: ThinkingChoices) => void = () => {};
    const { env, recorded } = environment([agent({ id: "s", workspaceId: "ws" })], {
      workspaces: [workspace({ id: "ws" })],
      selected: "ws",
    });
    env.thinkingChoices = () =>
      new Promise((resolve) => {
        finishLookup = resolve;
      });
    const abort = new AbortController();
    const plan = planTrigger({ kind: "run", action: "thinkingUp", text: "" }, env);
    const running = runPlan(plan, env, abort.signal);
    abort.abort(new Error("stopped"));
    finishLookup({ options: [{ id: "high", label: "High" }], current: null });
    await expect(running).rejects.toThrow("stopped");
    expect(recorded.calls).toEqual([]);
  });
});

describe("subagents", () => {
  const PARENT = "orchestrator";
  const included = SettingsSchema.parse({ agents: { includeSubagents: true } });
  const sub = (overrides: Partial<AgentInfo> & { id: string }) =>
    agent({ parentAgentId: PARENT, ...overrides });
  const waitingSub = (id: string, workspaceId: string) =>
    sub({ id, workspaceId, pendingPermissions: [permission({ id: `${id}-request` })] });

  it("are never the next agent that needs action, unless the settings include them", async () => {
    const subagent = waitingSub("sub", "a");
    const mine = agent({
      id: "mine",
      workspaceId: "b",
      requiresAttention: true,
      attentionReason: "finished",
      attentionAt: 50,
    });
    const workspaces = [workspace({ id: "a" }), workspace({ id: "b" })];
    const { env, recorded } = environment([subagent, mine], { workspaces });
    expect(await run("nextActionableAgent", env)).toMatchObject({ message: "Opened mine" });
    expect(await run("nextActionableAgent", env)).toMatchObject({
      message: "Opened mine again; no other agent needs action",
    });
    expect(recorded.calls).toEqual(["open mine", "open mine"]);

    const only = environment([subagent], { workspaces });
    expect(await run("nextActionableAgent", only.env)).toMatchObject({
      ok: true,
      message: "No agent needs action",
    });
    expect(only.recorded.calls).toEqual([]);
    expect(only.recorded.selected).toBeNull();

    const all = environment([subagent, mine], { workspaces, settings: included });
    await run("nextActionableAgent", all.env);
    await run("nextActionableAgent", all.env);
    expect(all.recorded.calls).toEqual(["open sub", "open mine"]);
  });

  it("are never a workspace key's agent, even when they wait and another agent is idle", async () => {
    const options = {
      workspaces: [workspace({ id: "ws" })],
      slots: ["ws", null, null, null, null, null] as Slots,
    };
    const agents = [
      waitingSub("sub", "ws"),
      sub({ id: "broken-sub", workspaceId: "ws", status: "error", activityAt: 99 }),
      agent({ id: "mine", workspaceId: "ws", activityAt: 1 }),
    ];
    const { env, recorded } = environment(agents, options);
    await pressWorkspaceKey(0, env);
    expect(recorded.calls).toEqual(["open mine"]);

    const all = environment(agents, { ...options, settings: included });
    await pressWorkspaceKey(0, all.env);
    expect(all.recorded.calls).toEqual(["open sub"]);
  });

  it("leave a workspace whose only waiting agent is a subagent with nothing to open", async () => {
    const options = {
      workspaces: [workspace({ id: "ws" })],
      slots: ["ws", null, null, null, null, null] as Slots,
      selected: "ws",
    };
    const { env, recorded } = environment([waitingSub("sub", "ws")], options);
    expect(await pressWorkspaceKey(0, env)).toMatchObject({
      ok: true,
      message: "Selected ws, which has only subagents",
    });
    expect(recorded.selected).toBe("ws");
    for (const action of ["stopAgent", "thinkingUp", "thinkingDown", "sendPrompt"] as const) {
      expect(await run(action, env, "Go")).toMatchObject({
        ok: false,
        message: "ws has only subagents",
      });
    }
    expect(await run("approvePermission", env)).toMatchObject({
      ok: true,
      message: "No pending permission requests",
    });
    expect(await run("nextStuckWorkspace", env)).toMatchObject({
      message: "No workspace needs input",
    });
    expect(recorded.calls).toEqual([]);

    const all = environment([waitingSub("sub", "ws")], { ...options, settings: included });
    await run("stopAgent", all.env);
    await run("approvePermission", all.env);
    expect(all.recorded.calls).toEqual(["stop sub", "allow sub sub-request"]);
  });

  it("are never the target of approve or deny, in the selected workspace or elsewhere", async () => {
    const workspaces = [workspace({ id: "ws" }), workspace({ id: "other" })];
    const mine = agent({
      id: "mine",
      workspaceId: "other",
      pendingPermissions: [permission({ id: "late" })],
    });
    const { env, recorded } = environment([waitingSub("sub", "ws"), mine], {
      workspaces,
      selected: "ws",
    });
    env.permissionSeenAt = (_agentId, requestId) => (requestId === "late" ? 2 : 1);
    await run("denyPermission", env);
    expect(recorded.calls).toEqual(["deny mine late"]);
    expect(recorded.selected).toBe("other");
  });

  it("are skipped when going back to a workspace that has only subagents", async () => {
    const workspaces = [workspace({ id: "a" }), workspace({ id: "b" })];
    const { env, recorded } = environment([sub({ id: "sub", workspaceId: "a" })], {
      workspaces,
    });
    recorded.history.visit({ workspaceId: "a", agentId: "sub" });
    recorded.history.visit({ workspaceId: "b", agentId: "gone" });
    expect(await run("navigateBack", env)).toMatchObject({
      message: "No earlier place in the keypad's history",
    });
    expect(recorded.calls).toEqual([]);
  });
});

describe("projects", () => {
  const inProject = (id: string, projectId: string, activityAt = 1_000) =>
    workspace({ id, projectId, projectName: projectId, activityAt });

  it("opens the next and previous project in name order, wrapping around", async () => {
    const { env, recorded } = environment(
      ["a1", "b1", "c1"].map((id) => agent({ id: `agent-${id}`, workspaceId: id })),
      {
        workspaces: [inProject("c1", "Gamma"), inProject("a1", "alpha"), inProject("b1", "Beta")],
        selected: "c1",
      },
    );
    await run("nextProject", env);
    await run("nextProject", env);
    await run("previousProject", env);
    await run("previousProject", env);
    expect(recorded.calls).toEqual([
      "open agent-a1",
      "open agent-b1",
      "open agent-a1",
      "open agent-c1",
    ]);
    expect(recorded.selected).toBe("c1");
    expect(recorded.history.list().map((place) => place.workspaceId)).toEqual([
      "a1",
      "b1",
      "a1",
      "c1",
    ]);
  });

  it("starts from the first or last project without a current one", async () => {
    const agents = ["a1", "b1"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const workspaces = [inProject("a1", "alpha"), inProject("b1", "beta")];
    const next = environment(agents, { workspaces });
    await run("nextProject", next.env);
    const previous = environment(agents, { workspaces });
    await run("previousProject", previous.env);
    expect([next.recorded.calls, previous.recorded.calls]).toEqual([
      ["open agent-a1"],
      ["open agent-b1"],
    ]);
  });

  it("takes the current project from the history when no workspace is selected", async () => {
    const agents = ["a1", "b1", "c1"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env, recorded } = environment(agents, {
      workspaces: [inProject("a1", "alpha"), inProject("b1", "beta"), inProject("c1", "gamma")],
    });
    recorded.history.visit({ workspaceId: "b1", agentId: "agent-b1" });
    await run("nextProject", env);
    expect(recorded.calls).toEqual(["open agent-c1"]);
  });

  it("opens the most recently active workspace with an agent, and its most relevant agent", async () => {
    const { env, recorded } = environment(
      [
        agent({ id: "old", workspaceId: "a-old", activityAt: 100 }),
        agent({ id: "busy", workspaceId: "a-busy", activityAt: 5_000 }),
        agent({
          id: "asking",
          workspaceId: "a-busy",
          activityAt: 10,
          pendingPermissions: [permission()],
        }),
        agent({ id: "b", workspaceId: "b1" }),
      ],
      {
        workspaces: [
          inProject("a-empty", "alpha", 9_000),
          inProject("a-old", "alpha", 200),
          inProject("a-busy", "alpha", 50),
          inProject("b1", "beta"),
        ],
        selected: "b1",
      },
    );
    await run("nextProject", env);
    expect(recorded.calls).toEqual(["open asking"]);
    expect(recorded.selected).toBe("a-busy");
  });

  it("skips projects without eligible workspaces, and does nothing with one project", async () => {
    // Only eligible workspaces reach actions, so a project whose workspaces are all archived
    // has none here.
    const agents = ["a1", "a2"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env, recorded } = environment(agents, {
      workspaces: [inProject("a1", "alpha"), inProject("a2", "alpha")],
      selected: "a1",
    });
    expect(navigationBlocker("nextProject", env)).toBe("there is no other project");
    expect(await run("nextProject", env)).toEqual({
      action: "nextProject",
      ok: true,
      message: "There is no other project",
    });
    expect(recorded.calls).toEqual([]);
  });
});

describe("newAgent", () => {
  it("sends Cmd+O, Paseo's shortcut for a new agent", async () => {
    const { env, recorded } = environment([]);
    expect(await run("newAgent", env)).toMatchObject({ ok: true });
    expect(recorded.calls).toEqual(["shortcut cmd+o"]);
  });
});

describe("navigationBlocker", () => {
  it("says why each navigation action cannot act, and nothing for other actions", async () => {
    const agents = ["a", "b"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env } = environment(agents, {
      workspaces: [workspace({ id: "a" })],
      slots: ["a", null, null, null, null, null],
    });
    expect(navigationBlocker("navigateBack", env)).toBe("no earlier place in the keypad's history");
    expect(navigationBlocker("navigateForward", env)).toBe(
      "no later place in the keypad's history",
    );
    expect(navigationBlocker("previousWorkspace", env)).toBe("there is no other workspace");
    expect(navigationBlocker("nextWorkspace", env)).toBe("there is no other workspace");
    expect(navigationBlocker("previousProject", env)).toBe("there is no other project");
    expect(navigationBlocker("submit", env)).toBeNull();
  });
});

describe("planTopKey", () => {
  const settingsFor = (topKeys: Record<string, unknown>) => SettingsSchema.parse({ topKeys });

  it("runs the navigation action of each key, or says why it cannot", async () => {
    const agents = ["a", "b"].map((id) => agent({ id: `agent-${id}`, workspaceId: id }));
    const { env, recorded } = environment(agents, {
      workspaces: ["a", "b"].map((id) => workspace({ id })),
    });
    expect(await runPlan(planTopKey(0, env), env)).toEqual({
      action: "navigateBack",
      ok: true,
      message: "No earlier place in the keypad's history",
    });
    await runPlan(planTopKey(3, env), env);
    await runPlan(planTopKey(4, env), env);
    expect(recorded.calls).toEqual(["shortcut cmd+[", "shortcut cmd+]"]);
  });

  it("does nothing in the off mode", () => {
    const { env } = environment([agent({ workspaceId: "a" })], {
      workspaces: [workspace({ id: "a" })],
      slots: ["a", null, null, null, null, null],
      settings: settingsFor({ mode: "off" }),
    });
    expect(planTopKey(0, env)).toEqual({ kind: "none" });
  });

  it("opens the key's workspace in the workspaces and pinned modes", async () => {
    for (const mode of ["workspaces", "pinned"]) {
      const { env, recorded } = environment([agent({ id: "x", workspaceId: "a" })], {
        workspaces: [workspace({ id: "a" })],
        slots: ["a", null, null, null, null, null],
        settings: settingsFor({ mode }),
      });
      await runPlan(planTopKey(0, env), env);
      expect(planTopKey(1, env)).toEqual({ kind: "none" });
      expect(recorded.calls).toEqual(["open x"]);
    }
  });

  it("selects a recent agent and its workspace, and opens it when asked", async () => {
    const { env, recorded } = environment(
      [agent({ id: "x", workspaceId: "a" }), agent({ id: "y", workspaceId: "a" })],
      {
        workspaces: [workspace({ id: "a" })],
        agentSlots: ["x", "y", null, null, null, null],
        settings: settingsFor({ mode: "recentAgents" }),
      },
    );
    expect(await runPlan(planTopKey(1, env), env)).toMatchObject({
      message: "Selected y; tap its key again to open it",
    });
    expect([recorded.selected, recorded.selectedAgent]).toEqual(["a", "y"]);
    expect(recorded.calls).toEqual([]);
    expect(await runPlan(planTopKey(1, env, true), env)).toMatchObject({
      message: "Opened y in a",
    });
    expect(recorded.calls).toEqual(["open y"]);
    expect(recorded.history.current()).toEqual({ workspaceId: "a", agentId: "y" });
    expect(planTopKey(2, env, true)).toEqual({ kind: "none" });
  });

  it("acts on the selected agent instead of the workspace's most relevant agent", async () => {
    const asking = agent({ id: "asking", workspaceId: "a", pendingPermissions: [permission()] });
    const quiet = agent({ id: "quiet", workspaceId: "a" });
    const { env, recorded } = environment([asking, quiet], {
      workspaces: [workspace({ id: "a" })],
      agentSlots: ["quiet", "asking", null, null, null, null],
      settings: settingsFor({ mode: "recentAgents" }),
    });
    await runPlan(planTopKey(0, env), env);
    await run("sendPrompt", env, "Continue");
    expect(recorded.calls).toEqual(["prompt quiet Continue"]);
    // Selecting the workspace by other means forgets the selected agent.
    env.select(null);
    env.select("a");
    recorded.calls.length = 0;
    await run("sendPrompt", env, "Continue");
    expect(recorded.calls).toEqual(["prompt asking Continue"]);
  });
});
