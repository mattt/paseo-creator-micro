import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { KeyState } from "../shared/settings";
import { isKeypadTarget, type AgentInfo } from "./agents";

/** What the plugin needs to know about one workspace. */
export interface WorkspaceInfo {
  readonly id: string;
  /** The workspace's title, else its name, such as a branch. */
  readonly name: string;
  /** The project's ID, which the daemon gives every workspace. */
  readonly projectId: string;
  readonly projectName: string;
  /** The daemon's activity time, else the creation time, in milliseconds; 0 when unknown. */
  readonly activityAt: number;
  /** The daemon is archiving the workspace. */
  readonly archiving: boolean;
  readonly background: boolean;
  readonly internal: boolean;
}

/** The state a workspace key shows. */
export type WorkspaceState = Exclude<KeyState, "empty">;

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function toWorkspaceInfo(descriptor: WorkspaceDescriptorPayload): WorkspaceInfo {
  return {
    id: descriptor.id,
    name: descriptor.title?.trim() || descriptor.name.trim() || descriptor.id.slice(0, 8),
    projectId: descriptor.projectId,
    projectName: descriptor.projectCustomName?.trim() || descriptor.projectDisplayName,
    activityAt: time(descriptor.activityAt) ?? time(descriptor.createdAt) ?? 0,
    archiving: descriptor.archivingAt != null,
    background: descriptor.background ?? false,
    internal: descriptor.internal ?? false,
  };
}

/** Whether a workspace can have a key: not being archived, not a background or internal workspace. */
export function isWorkspaceEligible(workspace: WorkspaceInfo): boolean {
  return !workspace.archiving && !workspace.background && !workspace.internal;
}

/** Whether an agent waits for the user: a pending permission request, question, or plan. */
export function needsInput(agent: AgentInfo): boolean {
  return (
    agent.pendingPermissions.length > 0 ||
    (agent.requiresAttention && agent.attentionReason === "permission")
  );
}

/** Whether an agent has a finished turn that the user has not read: Paseo's attention for `finished`. */
export function hasUnreadResult(agent: AgentInfo): boolean {
  return agent.requiresAttention && agent.attentionReason === "finished";
}

/** Whether an agent failed: its status is `error`, or Paseo's unread attention reason is `error`. */
export function hasFailed(agent: AgentInfo): boolean {
  return agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error");
}

/**
 * The state of one agent, by the first rule that applies:
 *
 * 1. failed: its status is `error`, or Paseo's unread attention reason is `error`.
 * 2. needsInput: a pending permission request (tool, plan, question, mode),
 *    or unread attention for a permission.
 * 3. running: its status is `running` or `initializing`.
 * 4. done: unread attention for a finished turn (Paseo's attention reason `finished`).
 * 5. idle: anything else, such as an agent whose results were read or that never ran.
 *
 * Paseo's `deriveAgentStateBucket` puts needs input before failed, files an
 * initializing agent and every other agent under `done`, and keeps unread
 * finished agents apart as `attention`, so the plugin applies its own order.
 *
 * A subagent, which another agent started, is only running or idle
 * unless `includeSubagents` is on: its failures, requests, and results are for the agent
 * that started it (see `isKeypadTarget`).
 */
export function agentState(agent: AgentInfo, includeSubagents = false): WorkspaceState {
  if (!isKeypadTarget(agent, includeSubagents)) return isRunning(agent) ? "running" : "idle";
  if (hasFailed(agent)) return "failed";
  if (needsInput(agent)) return "needsInput";
  if (isRunning(agent)) return "running";
  if (hasUnreadResult(agent)) return "done";
  return "idle";
}

/** Whether an agent is running or starting. */
export function isRunning(agent: AgentInfo): boolean {
  return agent.status === "running" || agent.status === "initializing";
}

const PRIORITY: readonly WorkspaceState[] = ["failed", "needsInput", "running", "done", "idle"];

/**
 * The most urgent state of a workspace's agents, or idle for a workspace without agents.
 * Subagents count only as running unless `includeSubagents` is on (see `agentState`).
 */
export function workspaceState(
  agents: readonly AgentInfo[],
  includeSubagents = false,
): WorkspaceState {
  let best = PRIORITY.length - 1;
  for (const agent of agents) {
    best = Math.min(best, PRIORITY.indexOf(agentState(agent, includeSubagents)));
  }
  return PRIORITY[best] ?? "idle";
}

/** Oldest first by the time the agent started to wait, then by ID. */
function waitedLongest(a: AgentInfo, b: AgentInfo): number {
  return (
    (a.attentionAt ?? a.activityAt) - (b.attentionAt ?? b.activityAt) || a.id.localeCompare(b.id)
  );
}

/**
 * The agent that a workspace key opens and that "the selected workspace's agent" means:
 * the agent that needs input, else the agent that failed, each the one that has waited longest,
 * else the most recently active agent. Null for a workspace without agents.
 * Callers pass only the agents that keypad actions may target (see `isKeypadTarget`).
 */
export function relevantAgent(agents: readonly AgentInfo[]): AgentInfo | null {
  const waiting = agents.filter(needsInput).sort(waitedLongest)[0];
  if (waiting) return waiting;
  const broken = agents.filter(hasFailed).sort(waitedLongest)[0];
  if (broken) return broken;
  return (
    [...agents].sort((a, b) => b.activityAt - a.activityAt || a.id.localeCompare(b.id))[0] ?? null
  );
}

/** Groups agents by workspace. Agents without a workspace are left out. */
export function agentsByWorkspace(
  agents: Iterable<AgentInfo>,
): ReadonlyMap<string, readonly AgentInfo[]> {
  const groups = new Map<string, AgentInfo[]>();
  for (const agent of agents) {
    if (agent.workspaceId === null) continue;
    const group = groups.get(agent.workspaceId);
    if (group) group.push(agent);
    else groups.set(agent.workspaceId, [agent]);
  }
  return groups;
}

/** A workspace and the time of its latest activity, its own or its agents', for key assignment. */
export interface SlotCandidate {
  readonly id: string;
  readonly activityAt: number;
}

/** The eligible workspaces, each with the latest activity of the workspace and its agents. */
export function slotCandidates(
  workspaces: Iterable<WorkspaceInfo>,
  agents: ReadonlyMap<string, readonly AgentInfo[]>,
): SlotCandidate[] {
  const candidates: SlotCandidate[] = [];
  for (const workspace of workspaces) {
    if (!isWorkspaceEligible(workspace)) continue;
    let activityAt = workspace.activityAt;
    for (const agent of agents.get(workspace.id) ?? []) {
      activityAt = Math.max(activityAt, agent.activityAt);
    }
    candidates.push({ id: workspace.id, activityAt });
  }
  return candidates;
}
