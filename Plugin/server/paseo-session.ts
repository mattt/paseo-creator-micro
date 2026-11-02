import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ThinkingChoices } from "./actions";
import { toAgentInfo, type AgentInfo } from "./agents";
import { LiveDirectory, type DirectorySource } from "./directory";
import { toWorkspaceInfo, type WorkspaceInfo } from "./workspaces";

/** The plugin's Paseo API, as handlers and hooks receive it. */
export type PaseoApi = PluginHandlerContext["paseo"];

type ModelList = Awaited<ReturnType<PaseoApi["providers"]["listModels"]>>;
type ModelDefinition = NonNullable<ModelList["models"]>[number];

export interface PaseoSessionOptions {
  /** Called with every agent the directory holds after each change. */
  onAgents: (agents: ReadonlyMap<string, AgentInfo>) => void;
  /** Called with every workspace the directory holds after each change. */
  onWorkspaces: (workspaces: ReadonlyMap<string, WorkspaceInfo>) => void;
  log: (message: string) => void;
  /** How long to wait before subscribing again after a failure. */
  retryMs?: number;
  /** How long a provider's model list stays cached. */
  modelCacheMs?: number;
  now?: () => number;
}

const MODEL_CACHE_MS = 5 * 60_000;

/** The daemon's largest page. Without a page, it also returns at most this many. */
const PAGE_LIMIT = 200;

const AGENT_QUERY = {
  filter: { includeArchived: false, includeBackground: false },
  sort: [{ key: "updated_at", direction: "desc" }],
} as const;

const WORKSPACE_QUERY = {
  filter: { includeBackground: false, includeInternal: false },
  sort: [{ key: "activity_at", direction: "desc" }],
} as const;

/** A model name that names a family, such as `opus`: one word, with no digits. */
const FAMILY_NAME = /^[A-Za-z]+$/;

type ModelKeys = Pick<ModelDefinition, "id" | "aliases" | "isDefault">;

/** The provider's model that a name means, by exact ID, then alias, then family. */
function modelNamed<Model extends ModelKeys>(
  models: readonly Model[],
  provider: string,
  name: string,
): Model | undefined {
  const exact = models.find((model) => model.id === name);
  if (exact) return exact;
  const aliased = models.find((model) => model.aliases?.includes(name));
  if (aliased) return aliased;
  if (!FAMILY_NAME.test(name)) return undefined;
  const family = `${provider}-${name}`;
  return models.find((model) => model.id === family || model.id.startsWith(`${family}-`));
}

/**
 * The provider's model that an agent runs, from the provider's list in its order.
 * Names are tried in this order: the live model from the snapshot's runtime info,
 * then the agent's configured model. For each name, the model is the one whose ID is the name,
 * else the one whose aliases include it, else, when the name is one word without digits
 * (a family, such as `opus`), the first model whose ID is `<provider>-<name>`
 * or starts with `<provider>-<name>-` (such as `claude-opus-5-5`).
 * An agent with no model name runs the provider's default model.
 * Otherwise the result is undefined: the plugin does not guess further.
 */
export function resolveModel<Model extends ModelKeys>(
  models: readonly Model[],
  agent: Pick<AgentInfo, "provider" | "model" | "liveModel">,
): Model | undefined {
  const names = [agent.liveModel, agent.model].filter(
    (name): name is string => name !== null && name !== "",
  );
  if (names.length === 0) return models.find((model) => model.isDefault);
  for (const name of names) {
    const model = modelNamed(models, agent.provider, name);
    if (model) return model;
  }
  return undefined;
}

function agentSource(paseo: PaseoApi): DirectorySource<AgentSnapshotPayload> {
  const list = (cursor?: string) => ({
    ...AGENT_QUERY,
    sort: [...AGENT_QUERY.sort],
    page: { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
  });
  return {
    noun: "agents",
    open: async () => {
      const result = await paseo.agents.list({ ...list(), subscribe: {} });
      return {
        release: () => result.subscription.release(),
        listen: (observer) => {
          result.subscription.subscribe({
            snapshot: (snapshot) =>
              observer.snapshot({
                entries: snapshot.entries.map((entry) => entry.agent),
                pageInfo: snapshot.pageInfo,
              }),
            update: (message) => {
              if (message.type !== "agent_update") return;
              const update = message.payload;
              observer.update(
                update.kind === "upsert"
                  ? { kind: "upsert", snapshot: update.agent }
                  : { kind: "remove", id: update.agentId },
              );
            },
            error: (error) => observer.error(error),
          });
        },
      };
    },
    page: async (cursor) => {
      const result = await paseo.agents.list(list(cursor));
      return { entries: result.entries.map((entry) => entry.agent), pageInfo: result.pageInfo };
    },
  };
}

function workspaceSource(paseo: PaseoApi): DirectorySource<WorkspaceDescriptorPayload> {
  const list = (cursor?: string) => ({
    filter: { ...WORKSPACE_QUERY.filter },
    sort: [...WORKSPACE_QUERY.sort],
    page: { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
  });
  return {
    noun: "workspaces",
    open: async () => {
      const result = await paseo.workspaces.list({ ...list(), subscribe: {} });
      return {
        release: () => result.subscription.release(),
        listen: (observer) => {
          result.subscription.subscribe({
            snapshot: (snapshot) =>
              observer.snapshot({ entries: snapshot.entries, pageInfo: snapshot.pageInfo }),
            update: (message) => {
              if (message.type !== "workspace_update") return;
              const update = message.payload;
              observer.update(
                update.kind === "upsert"
                  ? { kind: "upsert", snapshot: update.workspace }
                  : { kind: "remove", id: update.id },
              );
            },
            error: (error) => observer.error(error),
          });
        },
      };
    },
    page: async (cursor) => {
      const result = await paseo.workspaces.list(list(cursor));
      return { entries: result.entries, pageInfo: result.pageInfo };
    },
  };
}

/**
 * The plugin's view of the daemon through its Paseo API:
 * live directories of non-archived agents and workspaces, and the operations that actions use.
 */
export class PaseoSession {
  readonly paseo: PaseoApi;
  private readonly options: PaseoSessionOptions;
  private readonly agents: LiveDirectory<AgentSnapshotPayload, AgentInfo>;
  private readonly workspaces: LiveDirectory<WorkspaceDescriptorPayload, WorkspaceInfo>;
  private serverIdValue: string | null = null;
  private readonly models = new Map<string, { at: number; models: readonly ModelDefinition[] }>();

  constructor(paseo: PaseoApi, options: PaseoSessionOptions) {
    this.paseo = paseo;
    this.options = options;
    const shared = {
      log: options.log,
      ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    };
    this.agents = new LiveDirectory({
      ...shared,
      source: agentSource(paseo),
      idOf: (snapshot) => snapshot.id,
      toItem: toAgentInfo,
      onChange: options.onAgents,
    });
    this.workspaces = new LiveDirectory({
      ...shared,
      source: workspaceSource(paseo),
      idOf: (snapshot) => snapshot.id,
      toItem: toWorkspaceInfo,
      onChange: options.onWorkspaces,
    });
  }

  start(): void {
    this.agents.start();
    this.workspaces.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.agents.stop(), this.workspaces.stop()]);
  }

  /** Removes an agent at once, ahead of the directory update, when a hook reports it gone. */
  forget(agentId: string): void {
    this.agents.forget(agentId);
  }

  /** Removes a workspace at once, ahead of the directory update, when a hook reports it archived. */
  forgetWorkspace(workspaceId: string): void {
    this.workspaces.forget(workspaceId);
  }

  /** The daemon's server ID, for `paseo://` agent links. */
  async serverId(): Promise<string> {
    if (this.serverIdValue) return this.serverIdValue;
    const directory = await this.paseo.hosts.list();
    this.serverIdValue = directory.self.serverId;
    return this.serverIdValue;
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    await this.paseo.agents.ref(agentId).respondToPermission({ requestId, response });
  }

  /** Sends a prompt; a running turn receives it as steering instead of being interrupted. */
  async sendPrompt(agentId: string, text: string): Promise<void> {
    await this.paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
  }

  /**
   * The thinking options of the agent's model, in the provider's order, and the current one.
   * Null when the agent's model is not among the provider's models (see `resolveModel`).
   */
  async thinkingChoices(agent: AgentInfo): Promise<ThinkingChoices | null> {
    const model = resolveModel(await this.providerModels(agent), agent);
    if (!model) return null;
    const options = (model.thinkingOptions ?? []).map(({ id, label }) => ({ id, label }));
    const current =
      agent.thinkingOptionId ??
      model.defaultThinkingOptionId ??
      model.thinkingOptions?.find((option) => option.isDefault)?.id ??
      null;
    return { options, current };
  }

  private async providerModels(agent: AgentInfo): Promise<readonly ModelDefinition[]> {
    const now = (this.options.now ?? Date.now)();
    // The provider lists models for a project directory, so the list can differ by directory.
    const key = `${agent.provider}\u0000${agent.cwd}`;
    const cached = this.models.get(key);
    if (cached && now - cached.at < (this.options.modelCacheMs ?? MODEL_CACHE_MS)) {
      return cached.models;
    }
    const result = await this.paseo.providers.listModels(agent.provider, { cwd: agent.cwd });
    if (result.error) throw new Error(`Could not list ${agent.provider} models: ${result.error}`);
    const models = result.models ?? [];
    this.models.set(key, { at: now, models });
    return models;
  }
}
