import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { ActionId } from "../shared/actions";
import {
  NAVIGATION_KEY_ACTIONS,
  type KeypadSettings,
  type NavigationAction,
} from "../shared/settings";
import { requiresAction, type ActionableWalk } from "./actionable";
import { agentName, isKeypadTarget, type AgentInfo, type PendingPermission } from "./agents";
import type { ScrollEdge } from "./bridge-protocol";
import type { NavigationHistory, Place } from "./history";
import type { ActionTrigger, Gesture } from "./input-map";
import { adjacentProject, byRecentActivity, projectOrder, type ProjectEntry } from "./projects";
import type { Slots } from "./slots";
import { needsInput, relevantAgent, type WorkspaceInfo } from "./workspaces";

export interface ThinkingChoices {
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly current: string | null;
}

/**
 * The thinking option that the keypad last set for an agent, which the agent's snapshot
 * may not show yet. It applies while the snapshot still shows one of the `earlier` options:
 * the one from before the keypad's changes, and those that the keypad set since.
 */
export interface ThinkingNote {
  readonly optionId: string;
  readonly earlier: readonly (string | null)[];
}

/**
 * What actions can read and do. The controller supplies the real one; tests supply fakes.
 * Operations receive the action's signal, which aborts when the action is cancelled.
 */
export interface ActionEnvironment {
  /** Eligible agents, including subagents; actions choose targets with `targetAgents`. */
  agents(): readonly AgentInfo[];
  /** Eligible workspaces. */
  workspaces(): readonly WorkspaceInfo[];
  /** Workspace IDs on the top keys in the "workspaces" and "pinned" modes; empty in the others. */
  slots(): Slots;
  /** Agent IDs on the top keys in the "recentAgents" mode; empty in the others. */
  agentSlots(): Slots;
  selectedWorkspaceId(): string | null;
  /** Selects a workspace. A change of workspace forgets the selected agent. */
  select(workspaceId: string | null): void;
  /**
   * The agent that a tap on a recent agent's key selected, which the actions on the selected
   * workspace's agent use while it is in the selected workspace; else null.
   */
  selectedAgentId(): string | null;
  /** Selects an agent and its workspace. */
  selectAgent(agentId: string, workspaceId: string): void;
  /** The agent that the keypad opened last, so that "next agent that needs action" moves past it. */
  openedAgentId(): string | null;
  noteOpened(agentId: string): void;
  /** The round of "next agent that needs action", which remembers the agents it opened. */
  actionableWalk(): ActionableWalk;
  /**
   * Whether dictation is on, as far as the keypad's own Cmd+D shortcuts tell:
   * push to talk and its toggle record it, and submit stops it.
   */
  dictating(): boolean;
  noteDictating(active: boolean): void;
  /** The places that the keypad opened, for "go back" and "go forward". */
  history(): NavigationHistory;
  settings(): KeypadSettings;
  /**
   * When the plugin first saw a permission request, in milliseconds since the epoch,
   * with a fraction that orders requests seen in the same millisecond.
   * Infinity for a request it has not seen.
   */
  permissionSeenAt(agentId: string, requestId: string): number;
  /** Bridge operations handle cancellation themselves, preserving uncertain results. */
  openAgent(agentId: string, signal: AbortSignal): Promise<void>;
  sendShortcut(shortcut: string, signal: AbortSignal): Promise<void>;
  /** Scrolls Paseo's open conversation by lines: positive down, toward the newest messages. */
  scroll(lines: number, signal: AbortSignal): Promise<void>;
  /** Scrolls Paseo's open conversation toward its top or its bottom in one burst. */
  scrollToEdge(edge: ScrollEdge, signal: AbortSignal): Promise<void>;
  /**
   * Shows an agent's new thinking level on the workspace keys for a moment:
   * `position` is the level's index among the model's `count` thinking options.
   */
  showThinkingMeter(position: number, count: number): void;
  /** Flashes the workspace keys in the failure light for a moment: a thinking change failed. */
  showThinkingFailure(): void;
  /** The keypad's last thinking change for an agent, while its snapshot may lag (see `ThinkingNote`). */
  thinkingNote(agentId: string): ThinkingNote | null;
  noteThinking(agentId: string, note: ThinkingNote): void;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
    signal: AbortSignal,
  ): Promise<void>;
  sendPrompt(agentId: string, text: string, signal: AbortSignal): Promise<void>;
  thinkingChoices(agent: AgentInfo, signal: AbortSignal): Promise<ThinkingChoices | null>;
  stopAgent(agentId: string, signal: AbortSignal): Promise<void>;
  setThinking(agentId: string, optionId: string, signal: AbortSignal): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ActionResult {
  readonly action: ActionId;
  readonly ok: boolean;
  readonly message: string;
  /** The action may or may not have taken effect: its command went out, but no answer came. */
  readonly uncertain?: boolean;
}

/**
 * The work of one input, decided when the input arrives:
 * its binding, its target, and any change of selection are fixed then.
 */
export interface PlannedAction {
  readonly action: ActionId;
  /** The matched talk pair, used to reserve queue capacity for its release. */
  readonly talk?: { gesture: Gesture; phase: "start" | "stop" };
  /**
   * The lines of a scroll, which a scroll that arrives while this one waits adds to,
   * so that a fast turn of the dial does not fill the queue. Read when the scroll runs.
   */
  readonly scroll?: { lines: number };
  /**
   * The steps of a thinking change, which a thinking change for the same agent
   * in the same direction that arrives while this one waits adds to,
   * so that a fast turn of the held dial makes one change. Read when the change runs.
   */
  readonly thinking?: { readonly agentId: string; readonly direction: 1 | -1; steps: number };
  /**
   * Whether an input for the same action is ignored while this one waits or runs,
   * so that repeated presses never stack its work.
   */
  readonly ignoreRepeats?: boolean;
  /** Why the action no longer applies, or null while it does. Checked just before it runs. */
  stale(): string | null;
  /**
   * Does the work. Rejects with the signal's reason once the signal aborts.
   * Resolves to null when the work turned out to have nothing to do or report.
   */
  run(env: ActionEnvironment, signal: AbortSignal): Promise<ActionResult | null>;
}

/** What an input does: nothing, something already done, or work to run in turn. */
export type ActionPlan =
  | { readonly kind: "none" }
  | { readonly kind: "done"; readonly result: ActionResult }
  | { readonly kind: "queue"; readonly planned: PlannedAction };

/** A workspace with an agent that needs input, the agent to open, and when it started to wait. */
export interface StuckWorkspace {
  readonly workspace: WorkspaceInfo;
  readonly agent: AgentInfo;
  readonly waitingSince: number;
}

/**
 * The workspaces with an agent that needs input (a pending request, or unread permission attention),
 * the one that has waited longest first. Each comes with its agent that has waited longest.
 */
export function stuckWorkspaces(
  workspaces: readonly WorkspaceInfo[],
  agents: readonly AgentInfo[],
): StuckWorkspace[] {
  const stuck: StuckWorkspace[] = [];
  for (const workspace of workspaces) {
    const waiting = agents.filter(
      (agent) => agent.workspaceId === workspace.id && needsInput(agent),
    );
    const agent = relevantAgent(waiting);
    if (!agent) continue;
    const waitingSince = Math.min(...waiting.map((each) => each.attentionAt ?? each.activityAt));
    stuck.push({ workspace, agent, waitingSince });
  }
  return stuck.sort(
    (a, b) => a.waitingSince - b.waitingSince || a.workspace.id.localeCompare(b.workspace.id),
  );
}

/**
 * The workspace for "next stuck workspace": the one after the current workspace
 * in the order of `stuckWorkspaces`, wrapping around, or the one that has waited longest
 * when the current workspace does not wait. Null when no workspace waits.
 */
export function nextStuckWorkspace(
  workspaces: readonly WorkspaceInfo[],
  agents: readonly AgentInfo[],
  currentWorkspaceId: string | null,
): StuckWorkspace | null {
  const stuck = stuckWorkspaces(workspaces, agents);
  if (stuck.length === 0) return null;
  const index = stuck.findIndex((entry) => entry.workspace.id === currentWorkspaceId);
  return stuck[(index + 1) % stuck.length] ?? null;
}

export interface PermissionTarget {
  readonly agent: AgentInfo;
  readonly request: PendingPermission;
}

/**
 * The preferred agent's first pending request, else the oldest pending request of any agent.
 * The preferred agent is the selected workspace's agent.
 */
export function permissionTarget(
  agents: readonly AgentInfo[],
  preferredAgentId: string | null,
  seenAt: (agentId: string, requestId: string) => number,
): PermissionTarget | null {
  const preferred = agents.find((agent) => agent.id === preferredAgentId);
  const first = preferred?.pendingPermissions[0];
  if (preferred && first) return { agent: preferred, request: first };
  let best: (PermissionTarget & { seen: number }) | null = null;
  for (const agent of agents) {
    for (const request of agent.pendingPermissions) {
      const seen = seenAt(agent.id, request.id);
      if (best === null || seen < best.seen) best = { agent, request, seen };
    }
  }
  return best && { agent: best.agent, request: best.request };
}

/** The response that allows or denies a request, using the request's own action when it has one. */
export function permissionResponse(
  request: PendingPermission,
  allow: boolean,
): AgentPermissionResponse {
  if (allow) {
    return request.allowActionId
      ? { behavior: "allow", selectedActionId: request.allowActionId }
      : { behavior: "allow" };
  }
  return request.denyActionId
    ? { behavior: "deny", selectedActionId: request.denyActionId }
    : { behavior: "deny" };
}

/** The workspace on the next or previous occupied key, wrapping around. */
export function cycleSelection(
  slots: Slots,
  selectedWorkspaceId: string | null,
  step: 1 | -1,
): string | null {
  const occupied = slots.filter((id): id is string => id !== null);
  if (occupied.length === 0) return null;
  const index = selectedWorkspaceId === null ? -1 : occupied.indexOf(selectedWorkspaceId);
  if (index === -1) return step === 1 ? (occupied[0] ?? null) : (occupied.at(-1) ?? null);
  return occupied[(index + step + occupied.length) % occupied.length] ?? null;
}

/**
 * How many of the workspace keys the thinking meter lights for a level:
 * the level's share of the model's options, at least one key.
 * With six options, each level lights one more key; with three, two more.
 */
export function meterKeys(position: number, count: number, keys = 6): number {
  if (count <= 0 || position < 0) return 0;
  return Math.min(keys, Math.max(1, Math.round(((position + 1) * keys) / count)));
}

/**
 * The option `steps` options up or down the list, stopping at the end,
 * or null when the current option is already at that end.
 * From an unknown current option, the first step goes to the end opposite the direction.
 */
export function stepThinking(
  choices: ThinkingChoices,
  direction: 1 | -1,
  steps = 1,
): string | null {
  const ids = choices.options.map((option) => option.id);
  if (ids.length === 0 || steps < 1) return null;
  const known = choices.current === null ? -1 : ids.indexOf(choices.current);
  const index = known !== -1 ? known : direction === 1 ? -1 : ids.length;
  const target = Math.max(0, Math.min(ids.length - 1, index + direction * steps));
  return target === index ? null : (ids[target] ?? null);
}

const ok = (action: ActionId, message: string): ActionResult => ({ action, ok: true, message });
const failed = (action: ActionId, message: string): ActionResult => ({
  action,
  ok: false,
  message,
});

const NOTHING: ActionPlan = { kind: "none" };
const done = (result: ActionResult): ActionPlan => ({ kind: "done", result });
const queue = (
  action: ActionId,
  stale: () => string | null,
  run: PlannedAction["run"],
  talk?: PlannedAction["talk"],
): ActionPlan => ({ kind: "queue", planned: { action, stale, run, ...(talk ? { talk } : {}) } });
const always = () => null;

/**
 * Runs one operation of an action: refuses to start once the signal aborts,
 * stops waiting when it aborts, and checks it again after the operation.
 */
export async function step<T>(signal: AbortSignal, work: Promise<T> | (() => Promise<T>)) {
  signal.throwIfAborted();
  const pending = typeof work === "function" ? work() : work;
  const value = await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
  signal.throwIfAborted();
  return value;
}

/**
 * The eligible agents that actions may choose as targets: without subagents,
 * unless the settings include them (see `isKeypadTarget`).
 */
export function targetAgents(env: ActionEnvironment): readonly AgentInfo[] {
  const { includeSubagents } = env.settings().agents;
  return env.agents().filter((agent) => isKeypadTarget(agent, includeSubagents));
}

function findAgent(env: ActionEnvironment, agentId: string | null): AgentInfo | null {
  if (agentId === null) return null;
  return env.agents().find((agent) => agent.id === agentId) ?? null;
}

/** Why an action on an agent no longer applies: the agent closed or was archived. */
function goneReason(env: ActionEnvironment, agent: AgentInfo): string | null {
  return findAgent(env, agent.id) ? null : `${agentName(agent)} is no longer available`;
}

function findWorkspace(env: ActionEnvironment, workspaceId: string | null): WorkspaceInfo | null {
  if (workspaceId === null) return null;
  return env.workspaces().find((workspace) => workspace.id === workspaceId) ?? null;
}

function workspaceAgents(env: ActionEnvironment, workspaceId: string): AgentInfo[] {
  return targetAgents(env).filter((agent) => agent.workspaceId === workspaceId);
}

/** Why a workspace has no agent to act on, as a predicate: it has no agents, or only subagents. */
function noAgentReason(env: ActionEnvironment, workspace: WorkspaceInfo): string {
  const any = env.agents().some((agent) => agent.workspaceId === workspace.id);
  return any ? "has only subagents" : "has no agents";
}

/** The agent that the selected workspace's actions act on, or null; never a left-out subagent. */
export function workspaceTarget(env: ActionEnvironment, workspaceId: string | null) {
  const workspace = findWorkspace(env, workspaceId);
  if (!workspace) return null;
  return { workspace, agent: relevantAgent(workspaceAgents(env, workspace.id)) };
}

/**
 * The selected workspace and the agent that its actions act on: the agent that a tap on
 * a recent agent's key selected while it is in the workspace, else the most relevant agent
 * (`workspaceTarget`). Null without a selected workspace.
 */
export function selectedWorkspaceTarget(env: ActionEnvironment) {
  const target = workspaceTarget(env, env.selectedWorkspaceId());
  if (!target) return null;
  const chosen = env.selectedAgentId();
  const agent =
    chosen === null
      ? undefined
      : workspaceAgents(env, target.workspace.id).find((each) => each.id === chosen);
  return agent ? { workspace: target.workspace, agent } : target;
}

/**
 * The agent that stands in for the selected workspace's agent while no workspace is selected,
 * with `targets.fallback` "nextActionable": the agent that "open next agent that needs action"
 * would open next, by the same walk and without recording it, else the most recently active agent.
 * Subagents are left out unless the settings include them. Null without one, or with "none".
 */
export function fallbackAgent(env: ActionEnvironment): AgentInfo | null {
  if (env.settings().targets.fallback === "none") return null;
  const agents = targetAgents(env);
  const next = env
    .actionableWalk()
    .peek(agents, env.openedAgentId(), (agentId, requestId) =>
      env.permissionSeenAt(agentId, requestId),
    );
  if (next) return next;
  return (
    [...agents].sort((a, b) => b.activityAt - a.activityAt || a.id.localeCompare(b.id))[0] ?? null
  );
}

/**
 * The agent that actions on "the selected workspace's agent" act on:
 * with a selected workspace, the selected agent or its most relevant agent, which may be null
 * (`selectedWorkspaceTarget`); without one, the fallback agent (`fallbackAgent`),
 * with a null workspace.
 * It never selects a workspace. Null when there is neither.
 */
export function selectedTarget(
  env: ActionEnvironment,
): { workspace: WorkspaceInfo | null; agent: AgentInfo | null } | null {
  const selected = selectedWorkspaceTarget(env);
  if (selected) return selected;
  const agent = fallbackAgent(env);
  return agent && { workspace: null, agent };
}

/** Selects an agent's workspace when it can have a key, so that the keypad shows where it acted. */
function selectWorkspaceOf(env: ActionEnvironment, agent: AgentInfo): void {
  if (findWorkspace(env, agent.workspaceId)) env.select(agent.workspaceId);
}

/** Selects the workspace of an agent that the keypad opens, and records it for "go back". */
function visitWorkspaceOf(env: ActionEnvironment, agent: AgentInfo): void {
  const workspace = findWorkspace(env, agent.workspaceId);
  if (!workspace) return;
  env.select(workspace.id);
  env.history().visit({ workspaceId: workspace.id, agentId: agent.id });
}

/** Paseo's shortcuts for its previous and next workspace (`workspace.navigate.relative`). */
const WORKSPACE_SHORTCUTS = { previousWorkspace: "cmd+[", nextWorkspace: "cmd+]" } as const;

/** Paseo's shortcut for a new agent (`agent.new`) on macOS. */
const NEW_AGENT_SHORTCUT = "cmd+o";

/**
 * A place in the keypad's history as it is now: its workspace, if still eligible,
 * and its agent while it is still a target in that workspace, else the workspace's
 * most relevant agent. Null when the workspace is gone.
 */
export function placeTarget(
  env: ActionEnvironment,
  place: Place,
): { workspace: WorkspaceInfo; agent: AgentInfo | null } | null {
  const workspace = findWorkspace(env, place.workspaceId);
  if (!workspace) return null;
  const agents = workspaceAgents(env, workspace.id);
  const agent = agents.find((each) => each.id === place.agentId) ?? relevantAgent(agents);
  return { workspace, agent };
}

/** Whether "go back" or "go forward" can open a place: its workspace has an agent to open. */
function placeAvailable(env: ActionEnvironment): (place: Place) => boolean {
  return (place) => (placeTarget(env, place)?.agent ?? null) !== null;
}

/**
 * The project where the keypad is: the selected workspace's project,
 * else the project of the current place in the history; null when neither is eligible.
 */
export function currentProjectId(env: ActionEnvironment): string | null {
  const workspace =
    findWorkspace(env, env.selectedWorkspaceId()) ??
    findWorkspace(env, env.history().current()?.workspaceId ?? null);
  return workspace?.projectId ?? null;
}

/**
 * Where "previous project" or "next project" goes in a project: the most recently active
 * workspace with an agent to open, and its most relevant agent; else the most recently
 * active workspace, which has none.
 */
export function projectTarget(
  env: ActionEnvironment,
  project: ProjectEntry,
): { workspace: WorkspaceInfo; agent: AgentInfo | null } | null {
  const ordered = byRecentActivity(project.workspaces, env.agents());
  for (const workspace of ordered) {
    const agent = relevantAgent(workspaceAgents(env, workspace.id));
    if (agent) return { workspace, agent };
  }
  const first = ordered[0];
  return first ? { workspace: first, agent: null } : null;
}

/** The actions that the navigation mode's top keys run, with lights that say whether they can act. */
const NAVIGATION_ACTIONS: ReadonlySet<ActionId> = new Set(NAVIGATION_KEY_ACTIONS);

/**
 * Why a navigation action cannot act now, or null when it can:
 * back and forward need an earlier or later place in the keypad's history
 * whose workspace still has an agent to open; previous and next project need two projects
 * with eligible workspaces; previous and next workspace need two eligible workspaces.
 * Null for other actions.
 */
export function navigationBlocker(action: ActionId, env: ActionEnvironment): string | null {
  if (!NAVIGATION_ACTIONS.has(action)) return null;
  switch (action as NavigationAction) {
    case "navigateBack":
      return env.history().canGoBack(placeAvailable(env))
        ? null
        : "no earlier place in the keypad's history";
    case "navigateForward":
      return env.history().canGoForward(placeAvailable(env))
        ? null
        : "no later place in the keypad's history";
    case "previousProject":
    case "nextProject":
      return projectOrder(env.workspaces()).length >= 2 ? null : "there is no other project";
    case "previousWorkspace":
    case "nextWorkspace":
      return env.workspaces().length >= 2 ? null : "there is no other workspace";
  }
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Push to talk sends only Cmd+D, Paseo's dictation toggle, and optionally Return after a release;
 * never Cmd+Shift+D, which toggles voice mode.
 */
function planTalk(
  mode: "start" | "stop" | "toggle",
  env: ActionEnvironment,
  gesture: Gesture | undefined,
): ActionPlan {
  if (mode === "start") {
    return queue(
      "pushToTalk",
      always,
      async (env, signal) => {
        await env.sendShortcut("cmd+d", signal);
        if (gesture) gesture.started = true;
        env.noteDictating(true);
        return ok("pushToTalk", "Started dictation");
      },
      gesture ? { gesture, phase: "start" } : undefined,
    );
  }
  if (mode === "toggle") {
    return queue("pushToTalk", always, async (env, signal) => {
      const active = env.dictating();
      await env.sendShortcut("cmd+d", signal);
      env.noteDictating(!active);
      return ok("pushToTalk", "Toggled dictation");
    });
  }
  const { sendReturnOnRelease, returnDelayMs } = env.settings().pushToTalk;
  return queue(
    "pushToTalk",
    () => (gesture?.started ? null : "dictation did not start, so there is nothing to stop"),
    async (env, signal) => {
      // Submit, or a toggle, already stopped this press's dictation; Cmd+D would start it again.
      if (!env.dictating()) return null;
      await env.sendShortcut("cmd+d", signal);
      env.noteDictating(false);
      if (!sendReturnOnRelease) return ok("pushToTalk", "Stopped dictation");
      await step(signal, () => env.sleep(returnDelayMs, signal));
      await env.sendShortcut("return", signal);
      return ok("pushToTalk", "Stopped dictation and sent it");
    },
    gesture ? { gesture, phase: "stop" } : undefined,
  );
}

/**
 * Plans submitting the composer's text with Return.
 * When the keypad's dictation is on, such as while push to talk is held,
 * it stops dictation first and waits for the transcription to land, so that the text is sent.
 * Whether dictation is on is decided when the plan runs, after the actions before it.
 */
function planSubmit(): ActionPlan {
  return queue("submit", always, async (env, signal) => {
    if (!env.dictating()) {
      await env.sendShortcut("return", signal);
      return ok("submit", "Sent Return to Paseo");
    }
    await env.sendShortcut("cmd+d", signal);
    env.noteDictating(false);
    await step(signal, () => env.sleep(env.settings().pushToTalk.returnDelayMs, signal));
    await env.sendShortcut("return", signal);
    return ok("submit", "Stopped dictation and sent it");
  });
}

/**
 * Plans opening the next agent that requires action, chosen now:
 * record it in the round, select its workspace, and open it in turn.
 */
function planNextActionable(env: ActionEnvironment): ActionPlan {
  const action = "nextActionableAgent";
  const opened = env.openedAgentId();
  const agent = env
    .actionableWalk()
    .next(targetAgents(env), opened, (agentId, requestId) =>
      env.permissionSeenAt(agentId, requestId),
    );
  if (!agent) return done(ok(action, "No agent needs action"));
  const again = agent.id === opened;
  env.noteOpened(agent.id);
  visitWorkspaceOf(env, agent);
  const name = agentName(agent);
  return queue(
    action,
    () => {
      const current = findAgent(env, agent.id);
      if (!current) return `${name} is no longer available`;
      return requiresAction(current) ? null : `${name} no longer needs action`;
    },
    async (env, signal) => {
      await env.openAgent(agent.id, signal);
      return ok(
        action,
        again ? `Opened ${name} again; no other agent needs action` : `Opened ${name}`,
      );
    },
  );
}

function planPermission(allow: boolean, env: ActionEnvironment): ActionPlan {
  const action = allow ? "approvePermission" : "denyPermission";
  const preferred = selectedTarget(env)?.agent ?? null;
  const target = permissionTarget(targetAgents(env), preferred?.id ?? null, (agentId, requestId) =>
    env.permissionSeenAt(agentId, requestId),
  );
  if (!target) return done(ok(action, "No pending permission requests"));
  const { agent, request } = target;
  const name = agentName(agent);
  selectWorkspaceOf(env, agent);
  const stale = () => {
    const current = findAgent(env, agent.id);
    if (!current) return `${name} is no longer available`;
    return current.pendingPermissions.some((pending) => pending.id === request.id)
      ? null
      : `${name}'s request was already answered`;
  };
  if (request.kind === "question") {
    env.noteOpened(agent.id);
    visitWorkspaceOf(env, agent);
    return queue(action, stale, async (env, signal) => {
      await env.openAgent(agent.id, signal);
      return ok(action, `Opened ${name} to answer its question`);
    });
  }
  return queue(action, stale, async (env, signal) => {
    await step(signal, () =>
      env.respondToPermission(agent.id, request.id, permissionResponse(request, allow), signal),
    );
    return ok(
      action,
      `${allow ? "Approved" : "Denied"} ${request.title ?? "a request"} for ${name}`,
    );
  });
}

/** The agent with the thinking option that the keypad last set, while its snapshot lags. */
function withNotedThinking(env: ActionEnvironment, agent: AgentInfo) {
  const note = env.thinkingNote(agent.id);
  const applies = note !== null && note.earlier.includes(agent.thinkingOptionId);
  return {
    agent: applies ? { ...agent, thinkingOptionId: note.optionId } : agent,
    earlier: applies ? [...note.earlier, note.optionId] : [agent.thinkingOptionId],
  };
}

/**
 * Plans a thinking change by one step. Steps that arrive while it waits add to it
 * (see `PlannedAction.thinking`), and it moves by all of them with one `paseo` command,
 * to an option of the agent's model.
 * It starts from the newest state when it runs: the agent's snapshot,
 * or the keypad's last change while the snapshot does not show it yet.
 * When it fails, because the model is unknown, the model has no thinking options,
 * or the change itself fails, the workspace keys flash the failure light;
 * a cancelled change does not flash. At either end of the options, it shows the meter.
 */
function planThinking(direction: 1 | -1, agent: AgentInfo, env: ActionEnvironment): ActionPlan {
  const action = direction === 1 ? "thinkingUp" : "thinkingDown";
  const amount = { agentId: agent.id, direction, steps: 1 };
  const change = async (env: ActionEnvironment, signal: AbortSignal): Promise<ActionResult> => {
    const latest = withNotedThinking(env, findAgent(env, agent.id) ?? agent);
    const current = latest.agent;
    const name = agentName(current);
    const choices = await step(signal, () => env.thinkingChoices(current, signal));
    if (!choices) {
      const model = current.liveModel ?? current.model ?? "the default model";
      return failed(
        action,
        `${name}'s model, ${model}, is not among the ${current.provider} models`,
      );
    }
    if (choices.options.length === 0) {
      return failed(action, `${name}'s model has no thinking options`);
    }
    const ids = choices.options.map((option) => option.id);
    const next = stepThinking(choices, direction, amount.steps);
    if (next === null) {
      const end = direction === 1 ? "highest" : "lowest";
      env.showThinkingMeter(ids.indexOf(choices.current ?? ""), ids.length);
      return ok(action, `${name} is already at the ${end} option`);
    }
    await step(signal, () => env.setThinking(current.id, next, signal));
    env.noteThinking(current.id, { optionId: next, earlier: latest.earlier });
    env.showThinkingMeter(ids.indexOf(next), ids.length);
    const label = choices.options.find((option) => option.id === next)?.label ?? next;
    return ok(action, `Set ${name}'s thinking to ${label}`);
  };
  return {
    kind: "queue",
    planned: {
      action,
      thinking: amount,
      stale: () => goneReason(env, agent),
      run: async (env, signal) => {
        let result: ActionResult;
        try {
          result = await change(env, signal);
        } catch (error) {
          if (!signal.aborted) env.showThinkingFailure();
          throw error;
        }
        if (!result.ok) env.showThinkingFailure();
        return result;
      },
    },
  };
}

type ScrollAction = "scrollDown" | "scrollUp" | "scrollDownFast" | "scrollUpFast";

/**
 * Plans a scroll of Paseo's open conversation. Scrolls that arrive while it waits,
 * plain or fast, add their lines to it (see `PlannedAction.scroll`).
 */
function planScroll(action: ScrollAction, lines: number): ActionPlan {
  const down = action === "scrollDown" || action === "scrollDownFast";
  const amount = { lines: down ? lines : -lines };
  return {
    kind: "queue",
    planned: {
      action,
      stale: always,
      scroll: amount,
      run: async (env, signal) => {
        const total = amount.lines;
        if (total === 0) return null;
        await env.scroll(total, signal);
        const count = Math.abs(total) === 1 ? "1 line" : `${Math.abs(total)} lines`;
        return ok(action, `Scrolled ${total > 0 ? "down" : "up"} ${count}`);
      },
    },
  };
}

/**
 * Plans a jump to the bottom of Paseo's open conversation. Every jump goes to the bottom,
 * so a repeated jump does no harm, and a jump that arrives while another waits or runs
 * is ignored (see `PlannedAction.ignoreRepeats`).
 * The keypad never jumps to the top by default, because upward bursts, which make Paseo
 * load older messages, crashed its conversation list.
 */
function planJumpToBottom(): ActionPlan {
  const action = "jumpToBottom";
  return {
    kind: "queue",
    planned: {
      action,
      ignoreRepeats: true,
      stale: always,
      run: async (env, signal) => {
        await env.scrollToEdge("bottom", signal);
        return ok(action, "Jumped to the bottom");
      },
    },
  };
}

/**
 * Plans opening a workspace's agent, chosen now: select the workspace
 * and record the place in the history at once, and open the agent in turn.
 * `onKey` is the key that was pressed, if any;
 * the plan is skipped if that key shows another workspace by the time it runs.
 * Going back or forward (`record` false) moves in the history instead of recording.
 */
function planOpenWorkspace(
  action:
    | "openSelectedWorkspace"
    | "nextStuckWorkspace"
    | "navigateBack"
    | "navigateForward"
    | "previousProject"
    | "nextProject",
  workspace: WorkspaceInfo,
  agent: AgentInfo | null,
  env: ActionEnvironment,
  { onKey, record = true }: { onKey?: number; record?: boolean } = {},
): ActionPlan {
  env.select(workspace.id);
  if (!agent) {
    return done(ok(action, `Selected ${workspace.name}, which ${noAgentReason(env, workspace)}`));
  }
  env.noteOpened(agent.id);
  if (record) env.history().visit({ workspaceId: workspace.id, agentId: agent.id });
  const name = agentName(agent);
  return queue(
    action,
    () => {
      if (!findWorkspace(env, workspace.id)) return `${workspace.name} is no longer available`;
      if (onKey !== undefined && env.slots()[onKey] !== workspace.id) {
        return `key ${onKey + 1} now shows another workspace`;
      }
      return goneReason(env, agent);
    },
    async (env, signal) => {
      await env.openAgent(agent.id, signal);
      return ok(action, `Opened ${name} in ${workspace.name}`);
    },
  );
}

/**
 * Decides, as an input arrives, what its trigger does.
 * Selection changes happen at once, so that later inputs see them;
 * work that reaches outside the plugin is returned to run in turn.
 * `gesture` is the held input that a push-to-talk press or release belongs to.
 */
export function planTrigger(
  trigger: ActionTrigger,
  env: ActionEnvironment,
  gesture?: Gesture,
): ActionPlan {
  if (trigger.kind === "ignore") return NOTHING;
  if (trigger.kind === "talk") return planTalk(trigger.mode, env, gesture);
  const action = trigger.action;
  switch (action) {
    case "nextActionableAgent":
      return planNextActionable(env);
    case "nextStuckWorkspace": {
      const next = nextStuckWorkspace(
        env.workspaces(),
        targetAgents(env),
        env.selectedWorkspaceId(),
      );
      if (!next) return done(ok(action, "No workspace needs input"));
      return planOpenWorkspace(action, next.workspace, next.agent, env);
    }
    case "navigateBack":
    case "navigateForward": {
      const history = env.history();
      const available = placeAvailable(env);
      const place =
        action === "navigateBack" ? history.back(available) : history.forward(available);
      const target = place && placeTarget(env, place);
      if (!target) {
        const which = action === "navigateBack" ? "earlier" : "later";
        return done(ok(action, `No ${which} place in the keypad's history`));
      }
      return planOpenWorkspace(action, target.workspace, target.agent, env, { record: false });
    }
    case "previousProject":
    case "nextProject": {
      const project = adjacentProject(
        projectOrder(env.workspaces()),
        currentProjectId(env),
        action === "nextProject" ? 1 : -1,
      );
      const target = project && projectTarget(env, project);
      if (!target) return done(ok(action, "There is no other project"));
      return planOpenWorkspace(action, target.workspace, target.agent, env);
    }
    case "newAgent":
      return queue(action, always, async (env, signal) => {
        await env.sendShortcut(NEW_AGENT_SHORTCUT, signal);
        return ok(action, "Sent Cmd+O to start a new agent");
      });
    case "previousWorkspace":
    case "nextWorkspace": {
      const shortcut = WORKSPACE_SHORTCUTS[action];
      const direction = action === "nextWorkspace" ? "next" : "previous";
      return queue(action, always, async (env, signal) => {
        await env.sendShortcut(shortcut, signal);
        return ok(action, `Sent ${shortcut} to open the ${direction} workspace`);
      });
    }
    case "submit":
      return planSubmit();
    case "focusComposer":
      return queue(action, always, async (env, signal) => {
        await env.sendShortcut("cmd+l", signal);
        return ok(action, "Sent Cmd+L to focus the composer");
      });
    case "scrollDown":
    case "scrollUp":
      return planScroll(action, env.settings().scroll.lines);
    case "scrollDownFast":
    case "scrollUpFast":
      return planScroll(action, env.settings().scroll.fastLines);
    case "jumpToBottom":
      return planJumpToBottom();
    case "toggleVoiceMode":
      return queue(action, always, async (env, signal) => {
        await env.sendShortcut("cmd+shift+d", signal);
        return ok(action, "Toggled voice mode");
      });
    case "approvePermission":
      return planPermission(true, env);
    case "denyPermission":
      return planPermission(false, env);
    case "selectNextWorkspace":
    case "selectPreviousWorkspace": {
      const id = cycleSelection(
        env.slots(),
        env.selectedWorkspaceId(),
        action === "selectNextWorkspace" ? 1 : -1,
      );
      if (id === null) return done(ok(action, "No workspaces on the keys"));
      env.select(id);
      return done(ok(action, `Selected ${findWorkspace(env, id)?.name ?? id}`));
    }
  }
  // An input whose prompt is empty, as the joystick's are by default, does nothing.
  if (action === "sendPrompt" && trigger.text.trim() === "") {
    return done(ok(action, "No prompt is set for this input"));
  }
  if (action === "openSelectedWorkspace") {
    // Opening selects a workspace, so it has no fallback.
    const selected = selectedWorkspaceTarget(env);
    if (!selected) return done(failed(action, "No workspace is selected"));
    return planOpenWorkspace(action, selected.workspace, selected.agent, env);
  }
  const target = selectedTarget(env);
  if (!target) {
    return done(
      failed(
        action,
        env.settings().targets.fallback === "none"
          ? "No workspace is selected"
          : "No workspace is selected, and no agent can stand in for it",
      ),
    );
  }
  const agent = target.agent;
  if (!agent) {
    const workspace = target.workspace;
    return done(
      failed(
        action,
        workspace ? `${workspace.name} ${noAgentReason(env, workspace)}` : "No agent to act on",
      ),
    );
  }
  const name = agentName(agent);
  const stale = () => goneReason(env, agent);
  switch (action) {
    case "stopAgent":
      return queue(action, stale, async (env, signal) => {
        await step(signal, () => env.stopAgent(agent.id, signal));
        return ok(action, `Stopped ${name}`);
      });
    case "thinkingUp":
      return planThinking(1, agent, env);
    case "thinkingDown":
      return planThinking(-1, agent, env);
    case "sendPrompt": {
      const text = trigger.text;
      return queue(action, stale, async (env, signal) => {
        await step(signal, () => env.sendPrompt(agent.id, text, signal));
        return ok(action, `Sent a prompt to ${name}`);
      });
    }
  }
}

/**
 * Decides what a workspace key press does: select its workspace now,
 * and open the workspace's agent, chosen now, in turn.
 */
export function planWorkspaceKey(slot: number, env: ActionEnvironment): ActionPlan {
  const target = workspaceTarget(env, env.slots()[slot] ?? null);
  if (!target) return NOTHING;
  return planOpenWorkspace("openSelectedWorkspace", target.workspace, target.agent, env, {
    onKey: slot,
  });
}

/**
 * Decides what a press of a recent agent's key does (the "recentAgents" mode):
 * select the agent and its workspace now, and, when `open` is true, also open the agent
 * in turn, which brings Paseo to the front, and record it in the history.
 * The open is skipped if the key shows another agent, or the agent is gone, when it runs.
 */
export function planAgentKey(slot: number, env: ActionEnvironment, open: boolean): ActionPlan {
  const action = "openSelectedWorkspace";
  const agent = findAgent(env, env.agentSlots()[slot] ?? null);
  const workspace = agent && findWorkspace(env, agent.workspaceId);
  if (!agent || !workspace) return NOTHING;
  env.selectAgent(agent.id, workspace.id);
  const name = agentName(agent);
  if (!open) return done(ok(action, `Selected ${name}; tap its key again to open it`));
  env.noteOpened(agent.id);
  env.history().visit({ workspaceId: workspace.id, agentId: agent.id });
  return queue(
    action,
    () => {
      if (env.agentSlots()[slot] !== agent.id) return `key ${slot + 1} now shows another agent`;
      return goneReason(env, agent);
    },
    async (env, signal) => {
      await env.openAgent(agent.id, signal);
      return ok(action, `Opened ${name} in ${workspace.name}`);
    },
  );
}

/**
 * Decides what a press of a top key (keys 0–5) does in the settings' top-key mode.
 * `open` is whether a press in the "recentAgents" mode opens its agent:
 * on a double tap, or on every tap with `topKeys.openOnSingleTap`.
 *
 * - "workspaces" and "pinned": open the key's workspace (`planWorkspaceKey`).
 * - "navigation": run the key's navigation action (`NAVIGATION_KEY_ACTIONS`),
 *   or report why it cannot act (`navigationBlocker`).
 * - "recentAgents": select or open the key's agent (`planAgentKey`).
 * - "off": nothing.
 */
export function planTopKey(slot: number, env: ActionEnvironment, open = false): ActionPlan {
  const mode = env.settings().topKeys.mode;
  switch (mode) {
    case "workspaces":
    case "pinned":
      return planWorkspaceKey(slot, env);
    case "recentAgents":
      return planAgentKey(slot, env, open);
    case "off":
      return NOTHING;
    case "navigation": {
      const action = NAVIGATION_KEY_ACTIONS[slot];
      if (!action) return NOTHING;
      const blocker = navigationBlocker(action, env);
      if (blocker !== null) return done(ok(action, sentence(blocker)));
      return planTrigger({ kind: "run", action, text: "" }, env);
    }
  }
}

/** Runs a plan at once, checking first that it still applies. Returns null for no work. */
export async function runPlan(
  plan: ActionPlan,
  env: ActionEnvironment,
  signal: AbortSignal = new AbortController().signal,
): Promise<ActionResult | null> {
  if (plan.kind === "none") return null;
  if (plan.kind === "done") return plan.result;
  const reason = plan.planned.stale();
  if (reason !== null) return failed(plan.planned.action, `Skipped: ${reason}`);
  return plan.planned.run(env, signal);
}
