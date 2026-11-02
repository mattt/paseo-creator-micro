import type { AgentInfo } from "./agents";
import { hasFailed, hasUnreadResult, needsInput } from "./workspaces";

/**
 * Whether an agent requires the user's action: it needs input (a pending permission request,
 * question, or plan, or unread permission attention), it failed (the `error` status
 * or unread error attention), or it has an unread finished result.
 */
export function requiresAction(agent: AgentInfo): boolean {
  return needsInput(agent) || hasFailed(agent) || hasUnreadResult(agent);
}

/** The states of an agent that requires action, as its light shows them. */
export type ActionState = "failed" | "needsInput" | "done";

/**
 * Why an agent requires action, by the first rule that applies, as the workspace keys order them:
 * it failed, it needs input, or it has an unread finished result. Null when it requires none.
 */
export function actionState(agent: AgentInfo): ActionState | null {
  if (hasFailed(agent)) return "failed";
  if (needsInput(agent)) return "needsInput";
  if (hasUnreadResult(agent)) return "done";
  return null;
}

/**
 * When an agent started to wait, in milliseconds: its attention time, as for the other
 * "waited longest" orders, else the earliest time the plugin saw one of its pending requests,
 * else its latest activity.
 * `requestSeenAt` returns a non-finite number for a request the plugin has not seen.
 */
export function waitingSince(
  agent: AgentInfo,
  requestSeenAt: (agentId: string, requestId: string) => number,
): number {
  if (agent.attentionAt !== null) return agent.attentionAt;
  const seen = agent.pendingPermissions
    .map((request) => requestSeenAt(agent.id, request.id))
    .filter((time) => Number.isFinite(time));
  return seen.length > 0 ? Math.min(...seen) : agent.activityAt;
}

/** What an agent required when the keypad opened it, to tell a new request or result from it. */
interface Visit {
  readonly attentionAt: number | null;
  readonly requestIds: ReadonlySet<string>;
}

function visitOf(agent: AgentInfo): Visit {
  return {
    attentionAt: agent.requiresAttention ? agent.attentionAt : null,
    requestIds: new Set(agent.pendingPermissions.map((request) => request.id)),
  };
}

/**
 * The walk of "open next agent that needs action" through the agents that require action,
 * the one that has waited longest first.
 *
 * The Paseo 0.13.0 app clears a finished or error attention when the agent's screen gains focus
 * while the app is visible (`useAgentAttentionClear`). It never clears a permission attention
 * or an `error` status that way, and an attention that arrived while the agent was already
 * focused waits until the user focuses the composer, sends a prompt, or leaves the agent.
 * So the walk does not rely on opening to clear anything: it remembers the agents
 * that it opened in the current round and gives each press an agent that it has not opened yet.
 *
 * - It never picks the agent that the keypad opened last while another agent requires action.
 * - An agent that stops requiring action leaves the round, so it counts as new
 *   when it requires action again; so does an opened agent that has a newer attention
 *   or a new permission request.
 * - When every agent that requires action has been opened in the round, a new round starts.
 */
export class ActionableWalk {
  private readonly visits = new Map<string, Visit>();

  /**
   * Picks the next agent and records it as opened in the round, or returns null
   * when no agent requires action. `openedAgentId` is the agent that the keypad opened last,
   * by any action.
   */
  next(
    agents: readonly AgentInfo[],
    openedAgentId: string | null,
    requestSeenAt: (agentId: string, requestId: string) => number,
  ): AgentInfo | null {
    const { waiting, pick, newRound } = this.choose(agents, openedAgentId, requestSeenAt);
    const ids = new Set(waiting.map((agent) => agent.id));
    for (const id of this.visits.keys()) if (!ids.has(id)) this.visits.delete(id);
    if (newRound) this.visits.clear();
    if (!pick) return null;
    this.visits.set(pick.id, visitOf(pick));
    return pick;
  }

  /**
   * The agent that `next` would pick now with the same arguments, without recording anything,
   * or null when no agent requires action.
   */
  peek(
    agents: readonly AgentInfo[],
    openedAgentId: string | null,
    requestSeenAt: (agentId: string, requestId: string) => number,
  ): AgentInfo | null {
    return this.choose(agents, openedAgentId, requestSeenAt).pick;
  }

  /**
   * The choice of `next`: the agents that require action, the longest waiting first,
   * the pick, and whether the pick starts a new round. Changes nothing.
   * An agent that stopped requiring action is not among `waiting`,
   * so its old visit never decides the pick.
   */
  private choose(
    agents: readonly AgentInfo[],
    openedAgentId: string | null,
    requestSeenAt: (agentId: string, requestId: string) => number,
  ): { waiting: AgentInfo[]; pick: AgentInfo | null; newRound: boolean } {
    const waiting = agents
      .filter(requiresAction)
      .map((agent) => ({ agent, since: waitingSince(agent, requestSeenAt) }))
      .sort((a, b) => a.since - b.since || a.agent.id.localeCompare(b.agent.id))
      .map((entry) => entry.agent);
    const allowed =
      waiting.length > 1 ? waiting.filter((agent) => agent.id !== openedAgentId) : waiting;
    const unvisited = allowed.find((agent) => !this.visited(agent));
    if (unvisited) return { waiting, pick: unvisited, newRound: false };
    return { waiting, pick: allowed[0] ?? null, newRound: true };
  }

  private visited(agent: AgentInfo): boolean {
    const visit = this.visits.get(agent.id);
    if (!visit) return false;
    if (
      agent.requiresAttention &&
      agent.attentionAt !== null &&
      (visit.attentionAt === null || agent.attentionAt > visit.attentionAt)
    ) {
      return false;
    }
    return agent.pendingPermissions.every((request) => visit.requestIds.has(request.id));
  }
}
