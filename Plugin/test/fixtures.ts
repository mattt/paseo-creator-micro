import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { ActionEnvironment, ThinkingChoices, ThinkingNote } from "../server/actions";
import { ActionableWalk } from "../server/actionable";
import type { AgentInfo, PendingPermission } from "../server/agents";
import { NavigationHistory } from "../server/history";
import type { Slots } from "../server/slots";
import type { WorkspaceInfo } from "../server/workspaces";
import { SettingsSchema, type KeypadSettings } from "../shared/settings";

let sequence = 0;

/** An idle, eligible agent with no workspace and no attention, with the given overrides. */
export function agent(overrides: Partial<AgentInfo> & { id?: string } = {}): AgentInfo {
  sequence += 1;
  return {
    id: `agent-${sequence}`,
    workspaceId: null,
    title: null,
    provider: "claude",
    model: "claude-opus-5-5",
    liveModel: null,
    thinkingOptionId: null,
    cwd: "/tmp/project",
    status: "idle",
    requiresAttention: false,
    attentionReason: null,
    attentionAt: null,
    activityAt: 1_000,
    pendingPermissions: [],
    archived: false,
    internal: false,
    labeledServerId: null,
    parentAgentId: null,
    ...overrides,
  };
}

/** An eligible workspace with the given overrides; its name is its ID. */
export function workspace(overrides: Partial<WorkspaceInfo> & { id?: string } = {}): WorkspaceInfo {
  sequence += 1;
  const id = overrides.id ?? `workspace-${sequence}`;
  return {
    id,
    name: id,
    projectId: "project",
    projectName: "project",
    activityAt: 1_000,
    archiving: false,
    background: false,
    internal: false,
    ...overrides,
  };
}

export function permission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  sequence += 1;
  return {
    id: `request-${sequence}`,
    kind: "tool",
    title: "Run a command",
    allowActionId: null,
    denyActionId: null,
    ...overrides,
  };
}

const CLAUDE_THINKING = ["low", "medium", "high", "xhigh", "max", "ultracode"].map((id) => ({
  id,
  label: id === "xhigh" ? "Extra high" : id[0]!.toUpperCase() + id.slice(1),
}));

/**
 * Claude models as `providers.listModels("claude")` returned them on 2026-10-28,
 * in the provider's order, with no aliases. Opus 5 alone also has "off".
 */
export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", options: CLAUDE_THINKING, defaultOption: "medium" },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    options: [{ id: "off", label: "Off" }, ...CLAUDE_THINKING],
    defaultOption: "high",
  },
  { id: "claude-fable-5-1", label: "Fable 5.1", options: CLAUDE_THINKING, defaultOption: "high" },
  { id: "claude-fable-5", label: "Fable 5", options: CLAUDE_THINKING, defaultOption: "high" },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 1M",
    options: CLAUDE_THINKING,
    defaultOption: "high",
  },
].map(({ id, label, options, defaultOption }) => ({
  provider: "claude",
  id,
  label,
  thinkingOptions: options,
  defaultThinkingOptionId: defaultOption,
}));

/** What a fake action environment recorded. */
export interface Recorded {
  calls: string[];
  selected: string | null;
  selectedAgent: string | null;
  opened: string | null;
  history: NavigationHistory;
  dictating: boolean;
}

/**
 * A fake action environment over agents and workspaces, which records the calls
 * that actions make instead of making them.
 */
export function environment(
  agentList: AgentInfo[],
  options: {
    workspaces?: WorkspaceInfo[];
    slots?: Slots;
    agentSlots?: Slots;
    selected?: string | null;
    opened?: string | null;
    settings?: KeypadSettings;
    choices?: ThinkingChoices;
  } = {},
): {
  env: ActionEnvironment;
  recorded: Recorded;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
} {
  const recorded: Recorded = {
    calls: [],
    selected: options.selected ?? null,
    selectedAgent: null,
    opened: options.opened ?? null,
    history: new NavigationHistory(),
    dictating: false,
  };
  const walk = new ActionableWalk();
  const notes = new Map<string, ThinkingNote>();
  const settings = options.settings ?? SettingsSchema.parse({});
  const agents = [...agentList];
  const workspaces = [...(options.workspaces ?? [])];
  const env: ActionEnvironment = {
    agents: () => agents,
    workspaces: () => workspaces,
    slots: () => options.slots ?? [null, null, null, null, null, null],
    agentSlots: () => options.agentSlots ?? [null, null, null, null, null, null],
    selectedWorkspaceId: () => recorded.selected,
    select: (id) => {
      if (id !== recorded.selected) recorded.selectedAgent = null;
      recorded.selected = id;
    },
    selectedAgentId: () => recorded.selectedAgent,
    selectAgent: (agentId, workspaceId) => {
      recorded.selected = workspaceId;
      recorded.selectedAgent = agentId;
    },
    openedAgentId: () => recorded.opened,
    noteOpened: (id) => {
      recorded.opened = id;
    },
    actionableWalk: () => walk,
    dictating: () => recorded.dictating,
    noteDictating: (active) => {
      recorded.dictating = active;
    },
    history: () => recorded.history,
    settings: () => settings,
    permissionSeenAt: () => 0,
    openAgent: async (id) => void recorded.calls.push(`open ${id}`),
    sendShortcut: async (shortcut) => void recorded.calls.push(`shortcut ${shortcut}`),
    scroll: async (lines) => void recorded.calls.push(`scroll ${lines}`),
    scrollToEdge: async (edge) => void recorded.calls.push(`edge ${edge}`),
    showThinkingMeter: (position, count) => void recorded.calls.push(`meter ${position}/${count}`),
    showThinkingFailure: () => void recorded.calls.push("failure flash"),
    thinkingNote: (id) => notes.get(id) ?? null,
    noteThinking: (id, note) => void notes.set(id, note),
    respondToPermission: async (id, requestId, response: AgentPermissionResponse) =>
      void recorded.calls.push(`${response.behavior} ${id} ${requestId}`),
    sendPrompt: async (id, text) => void recorded.calls.push(`prompt ${id} ${text}`),
    thinkingChoices: async () => options.choices ?? null,
    stopAgent: async (id) => void recorded.calls.push(`stop ${id}`),
    setThinking: async (id, option) => void recorded.calls.push(`thinking ${id} ${option}`),
    sleep: async (ms) => void recorded.calls.push(`sleep ${ms}`),
  };
  return { env, recorded, agents, workspaces };
}
