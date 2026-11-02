import type { ActionId } from "../shared/actions";
import { WORKSPACE_KEY_COUNT } from "../shared/keypad";
import { DOUBLE_TAP_MS, NAVIGATION_KEY_ACTIONS, type KeyState } from "../shared/settings";
import { navigationBlocker, selectedWorkspaceTarget, type ActionEnvironment } from "./actions";
import { agentName, type AgentInfo } from "./agents";
import { agentState, workspaceState } from "./workspaces";

/** What a top key shows: a workspace, an agent, a navigation action, or nothing. */
export type TopKeyKind = "workspace" | "agent" | "navigation" | "off";

/** One top key (0–5) as the lights and the status describe it. */
export interface TopKeyInfo {
  readonly key: number;
  readonly kind: TopKeyKind;
  /** The key's workspace, or the workspace of its agent. */
  readonly workspaceId: string | null;
  readonly agentId: string | null;
  /** The navigation action of the key in the navigation mode. */
  readonly action: ActionId | null;
  /** The workspace's name, the agent's name, or null. */
  readonly title: string | null;
  readonly project: string | null;
  /** The workspace's eligible agents; 1 for an agent's key. */
  readonly agentCount: number;
  /** The state of the key's workspace or agent; "empty" for a key without one. */
  readonly state: KeyState;
  readonly pinned: boolean;
  /** The key's workspace is selected, or its agent is the selected workspace's agent. */
  readonly selected: boolean;
  /** Whether a press of the key can act now. */
  readonly enabled: boolean;
}

const nothing = {
  workspaceId: null,
  agentId: null,
  action: null,
  title: null,
  project: null,
  agentCount: 0,
  state: "empty",
  pinned: false,
  selected: false,
  enabled: false,
} as const;

/**
 * Describes the six top keys in the settings' top-key mode:
 * the workspaces of `env.slots()`, the agents of `env.agentSlots()`,
 * the navigation actions with whether each can act (`navigationBlocker`), or nothing.
 * `workspaceAgents` groups the eligible agents by workspace.
 */
export function topKeys(
  env: ActionEnvironment,
  workspaceAgents: ReadonlyMap<string, readonly AgentInfo[]>,
): TopKeyInfo[] {
  const settings = env.settings();
  const { includeSubagents } = settings.agents;
  const mode = settings.topKeys.mode;
  const workspaces = new Map(env.workspaces().map((workspace) => [workspace.id, workspace]));
  const agents = new Map(env.agents().map((agent) => [agent.id, agent]));
  const selectedAgent = selectedWorkspaceTarget(env)?.agent ?? null;
  return Array.from({ length: WORKSPACE_KEY_COUNT }, (_, key): TopKeyInfo => {
    switch (mode) {
      case "off":
        return { key, kind: "off", ...nothing };
      case "navigation": {
        const action = NAVIGATION_KEY_ACTIONS[key] ?? null;
        return {
          key,
          kind: "navigation",
          ...nothing,
          action,
          enabled: action !== null && navigationBlocker(action, env) === null,
        };
      }
      case "recentAgents": {
        const agent = agents.get(env.agentSlots()[key] ?? "");
        if (!agent) return { key, kind: "agent", ...nothing };
        const workspace = workspaces.get(agent.workspaceId ?? "");
        return {
          key,
          kind: "agent",
          ...nothing,
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          title: agentName(agent),
          project: workspace?.projectName ?? null,
          agentCount: 1,
          state: agentState(agent, includeSubagents),
          selected: agent.id === selectedAgent?.id,
          enabled: true,
        };
      }
      case "workspaces":
      case "pinned": {
        const workspace = workspaces.get(env.slots()[key] ?? "");
        if (!workspace) return { key, kind: "workspace", ...nothing };
        const members = workspaceAgents.get(workspace.id) ?? [];
        return {
          key,
          kind: "workspace",
          ...nothing,
          workspaceId: workspace.id,
          title: workspace.name,
          project: workspace.projectName,
          agentCount: members.length,
          state: workspaceState(members, includeSubagents),
          pinned: settings.pins[key] === workspace.id,
          selected: workspace.id === env.selectedWorkspaceId(),
          enabled: true,
        };
      }
    }
  });
}

/**
 * Tells a double tap of a recent agent's key from a single tap:
 * a second tap of the same key, while it shows the same agent, within `windowMs`.
 * A double tap ends the pair, so that a third tap counts as a new first tap.
 */
export class TapTracker {
  private last: { key: number; id: string; at: number } | null = null;

  constructor(private readonly windowMs = DOUBLE_TAP_MS) {}

  /** Records a tap, and returns whether it completes a double tap. */
  tap(key: number, id: string, at: number): boolean {
    const last = this.last;
    const double =
      last !== null && last.key === key && last.id === id && at - last.at <= this.windowMs;
    this.last = double ? null : { key, id, at };
    return double;
  }

  /** Forgets the last tap, as after a lost connection. */
  reset(): void {
    this.last = null;
  }
}
