import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

export type AgentStatus = AgentSnapshotPayload["status"];
export type AttentionReason = "finished" | "error" | "permission";

export interface PendingPermission {
  readonly id: string;
  readonly kind: AgentPermissionRequest["kind"];
  readonly title: string | null;
  /** The request's own allow action, when it offers choices. */
  readonly allowActionId: string | null;
  /** The request's own deny action, when it offers choices. */
  readonly denyActionId: string | null;
}

/** What the plugin needs to know about one agent. */
export interface AgentInfo {
  readonly id: string;
  /** The agent's workspace, or null when the daemon reports none. */
  readonly workspaceId: string | null;
  readonly title: string | null;
  readonly provider: string;
  /** The model that the agent was configured with, which can be an alias such as `opus`. */
  readonly model: string | null;
  /** The model that the provider reports the agent is running, when it reports one. */
  readonly liveModel: string | null;
  readonly thinkingOptionId: string | null;
  readonly cwd: string;
  readonly status: AgentStatus;
  readonly requiresAttention: boolean;
  readonly attentionReason: AttentionReason | null;
  /** Milliseconds since the epoch, or null. */
  readonly attentionAt: number | null;
  /** The latest of the agent's update, user message, and attention times, in milliseconds. */
  readonly activityAt: number;
  readonly pendingPermissions: readonly PendingPermission[];
  readonly archived: boolean;
  readonly internal: boolean;
  /** The server ID that Paseo recorded in the agent's labels, if any. */
  readonly labeledServerId: string | null;
  /**
   * The agent that started this one, which Paseo records in the agent's labels,
   * or null when no agent started it. See `isKeypadTarget`.
   */
  readonly parentAgentId: string | null;
}

/**
 * The label in which Paseo records the agent that started an agent:
 * `PARENT_AGENT_ID_LABEL` in `@getpaseo/protocol/agent-labels`, which `paseo agent inspect`
 * shows as `ParentAgentId`. The plugin repeats it because Paseo supplies only
 * `@getpaseo/plugin` and `zod` to plugin code at run time, not `@getpaseo/protocol`.
 */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** The parent agent's ID in an agent's labels, read as Paseo's `getParentAgentIdFromLabels` reads it. */
export function parentAgentIdFrom(labels: Readonly<Record<string, string>>): string | null {
  const value = labels[PARENT_AGENT_ID_LABEL]?.trim();
  return value ? value : null;
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toPendingPermission(request: AgentPermissionRequest): PendingPermission {
  const actions = request.actions ?? [];
  const preferred = (behavior: "allow" | "deny") =>
    actions.find((action) => action.behavior === behavior && action.variant === "primary") ??
    actions.find((action) => action.behavior === behavior);
  return {
    id: request.id,
    kind: request.kind,
    title: request.title ?? null,
    allowActionId: preferred("allow")?.id ?? null,
    denyActionId: preferred("deny")?.id ?? null,
  };
}

export function toAgentInfo(snapshot: AgentSnapshotPayload): AgentInfo {
  const attentionAt = time(snapshot.attentionTimestamp);
  const activityAt = Math.max(
    time(snapshot.updatedAt) ?? 0,
    time(snapshot.lastUserMessageAt) ?? 0,
    attentionAt ?? 0,
  );
  return {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId ?? null,
    title: snapshot.title,
    provider: snapshot.provider,
    model: snapshot.model,
    liveModel: snapshot.runtimeInfo?.model ?? null,
    thinkingOptionId: snapshot.effectiveThinkingOptionId ?? snapshot.thinkingOptionId ?? null,
    cwd: snapshot.cwd,
    status: snapshot.status,
    requiresAttention: snapshot.requiresAttention ?? false,
    attentionReason: snapshot.attentionReason ?? null,
    attentionAt,
    activityAt,
    pendingPermissions: snapshot.pendingPermissions.map(toPendingPermission),
    archived: snapshot.archivedAt != null,
    internal: snapshot.internal ?? false,
    labeledServerId: snapshot.labels["paseo.parent-server-id"] ?? null,
    parentAgentId: parentAgentIdFrom(snapshot.labels),
  };
}

/** Whether an agent counts: open, not archived, and not one of Paseo's internal agents. */
export function isEligible(agent: AgentInfo): boolean {
  return !agent.archived && !agent.internal && agent.status !== "closed";
}

/** Whether another agent started an agent, such as an agent that an orchestrating agent runs. */
export function isSubagent(agent: AgentInfo): boolean {
  return agent.parentAgentId !== null;
}

/**
 * Whether keypad actions may target an agent and its attention counts on the keys:
 * an agent that no other agent started, or any agent when `includeSubagents` is on.
 * The parent agent controls a subagent.
 * A subagent still counts as running; see `agentState`.
 */
export function isKeypadTarget(agent: AgentInfo, includeSubagents: boolean): boolean {
  return includeSubagents || !isSubagent(agent);
}

/** A short name for logs and the interface. */
export function agentName(agent: AgentInfo): string {
  return agent.title?.trim() || agent.id.slice(0, 8);
}
