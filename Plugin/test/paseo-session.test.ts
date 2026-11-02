import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vite-plus/test";
import type { AgentInfo } from "../server/agents";
import { PaseoSession, resolveModel, type PaseoApi } from "../server/paseo-session";
import type { WorkspaceInfo } from "../server/workspaces";
import { agent, CLAUDE_MODELS } from "./fixtures";

function snapshot(id: string, overrides: Record<string, unknown> = {}): AgentSnapshotPayload {
  return {
    id,
    provider: "claude",
    cwd: "/tmp/project",
    model: "claude-opus-5-5",
    thinkingOptionId: null,
    status: "idle",
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    lastUserMessageAt: null,
    pendingPermissions: [],
    title: `Agent ${id}`,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    ...overrides,
  } as unknown as AgentSnapshotPayload;
}

type Observer = { update(message: unknown): void; snapshot(value: unknown): void };

/** A directory of agents served in pages of two, as the daemon pages its agent list. */
function pagedPaseo(
  ids: string[],
  options: { beforePage?: (cursor: string) => void | Promise<void> } = {},
) {
  const observers: Observer[] = [];
  const requests: { cursor?: string; subscribe: boolean }[] = [];
  const page = (cursor: string | undefined) => {
    const start = cursor ? Number(cursor) : 0;
    const end = start + 2;
    return {
      entries: ids.slice(start, end).map((id) => ({ agent: snapshot(id) })),
      pageInfo: {
        nextCursor: end < ids.length ? String(end) : null,
        prevCursor: cursor ?? null,
        hasMore: end < ids.length,
      },
    };
  };
  const api = {
    agents: {
      list: async (request: { page?: { cursor?: string }; subscribe?: object }) => {
        const cursor = request.page?.cursor;
        requests.push({ ...(cursor ? { cursor } : {}), subscribe: Boolean(request.subscribe) });
        if (cursor) await options.beforePage?.(cursor);
        const result = page(cursor);
        if (!request.subscribe) return result;
        return {
          ...result,
          subscription: {
            subscribe(observer: Observer) {
              observers.push(observer);
              observer.snapshot(result);
              return () => {};
            },
            release: async () => {},
          },
        };
      },
    },
  };
  return {
    paseo: api as unknown as PaseoApi,
    requests,
    refresh(nextIds: string[]) {
      ids = nextIds;
      for (const observer of observers) observer.snapshot(page(undefined));
    },
    remove(agentId: string) {
      for (const observer of observers)
        observer.update({
          type: "agent_update",
          payload: { kind: "remove", agentId },
        });
    },
    update(agentSnapshot: AgentSnapshotPayload) {
      for (const observer of observers) {
        observer.update({
          type: "agent_update",
          payload: { kind: "upsert", agent: agentSnapshot },
        });
      }
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("PaseoSession", () => {
  it("loads every page of agents, not only the first", async () => {
    const fake = pagedPaseo(["a", "b", "c", "d", "e"]);
    let latest: ReadonlyMap<string, AgentInfo> = new Map();
    const session = new PaseoSession(fake.paseo, {
      onAgents: (agents) => (latest = new Map(agents)),
      onWorkspaces: () => {},
      log: () => {},
    });
    session.start();
    await settle();
    expect([...latest.keys()].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(fake.requests).toEqual([
      { subscribe: true },
      { cursor: "2", subscribe: false },
      { cursor: "4", subscribe: false },
    ]);
    await session.stop();
  });

  it("keeps an update that arrives while a later page loads", async () => {
    let fake: ReturnType<typeof pagedPaseo> | null = null;
    fake = pagedPaseo(["a", "b", "c"], {
      beforePage: () => fake?.update(snapshot("c", { status: "running" })),
    });
    let latest: ReadonlyMap<string, AgentInfo> = new Map();
    const session = new PaseoSession(fake.paseo, {
      onAgents: (agents) => (latest = new Map(agents)),
      onWorkspaces: () => {},
      log: () => {},
    });
    session.start();
    await settle();
    expect(latest.get("c")?.status).toBe("running");
    await session.stop();
  });

  it("keeps the complete directory until a refresh finishes and applies concurrent updates", async () => {
    let gate: Promise<void> | undefined;
    let finish = () => {};
    const fake = pagedPaseo(["a", "b", "c", "d"], { beforePage: () => gate });
    const published: string[][] = [];
    let latest: ReadonlyMap<string, AgentInfo> = new Map();
    const session = new PaseoSession(fake.paseo, {
      onAgents: (agents) => {
        latest = new Map(agents);
        published.push([...agents.keys()]);
      },
      onWorkspaces: () => {},
      log: () => {},
    });
    session.start();
    await settle();
    gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.refresh(["b", "e", "c", "d"]);
    await settle();
    expect([...latest.keys()]).toEqual(["a", "b", "c", "d"]);
    fake.update(snapshot("c", { status: "running" }));
    fake.remove("d");
    finish();
    await settle();
    expect([...latest.keys()].sort()).toEqual(["b", "c", "e"]);
    expect(latest.get("c")?.status).toBe("running");
    expect(published.every((ids) => ids.includes("c"))).toBe(true);
    await session.stop();
  });

  it("keeps the last complete directory on page failure and retries without another snapshot", async () => {
    let failures = 0;
    let fail = false;
    const fake = pagedPaseo(["a", "b", "c"], {
      beforePage: () => {
        if (fail) {
          failures++;
          throw new Error("page unavailable");
        }
      },
    });
    let latest: ReadonlyMap<string, AgentInfo> = new Map();
    const session = new PaseoSession(fake.paseo, {
      onAgents: (agents) => {
        latest = new Map(agents);
      },
      onWorkspaces: () => {},
      log: () => {},
      retryMs: 20,
    });
    session.start();
    await settle();
    fail = true;
    fake.refresh(["b", "d", "c"]);
    await settle();
    expect(failures).toBe(1);
    expect([...latest.keys()]).toEqual(["a", "b", "c"]);
    fake.update(snapshot("c", { status: "running" }));
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([...latest.keys()].sort()).toEqual(["b", "c", "d"]);
    expect(latest.get("c")?.status).toBe("running");
    expect(fake.requests.filter((request) => request.subscribe)).toHaveLength(1);
    await session.stop();
  });

  it("discards pages superseded by a newer snapshot", async () => {
    let gate: Promise<void> | undefined;
    let finish = () => {};
    const fake = pagedPaseo(["a", "b", "c"], { beforePage: () => gate });
    let latest: ReadonlyMap<string, AgentInfo> = new Map();
    const session = new PaseoSession(fake.paseo, {
      onAgents: (agents) => {
        latest = new Map(agents);
      },
      onWorkspaces: () => {},
      log: () => {},
    });
    session.start();
    await settle();
    gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.refresh(["d", "e", "f"]);
    fake.refresh(["g"]);
    finish();
    await settle();
    expect([...latest.keys()]).toEqual(["g"]);
    await session.stop();
  });

  it("follows every page of workspaces and their updates", async () => {
    const workspace = (id: string, overrides: Record<string, unknown> = {}) =>
      ({
        id,
        projectId: "p",
        projectDisplayName: "project",
        projectRootPath: "/tmp/project",
        projectKind: "git",
        workspaceKind: "worktree",
        name: `branch-${id}`,
        archivingAt: null,
        status: "done",
        statusEnteredAt: null,
        activityAt: "2026-10-27T10:00:00.000Z",
        ...overrides,
      }) as unknown as WorkspaceDescriptorPayload;
    const observers: Observer[] = [];
    const requests: unknown[] = [];
    const ids = ["w1", "w2", "w3"];
    const page = (cursor?: string) => {
      const start = cursor ? Number(cursor) : 0;
      const end = start + 2;
      return {
        entries: ids.slice(start, end).map((id) => workspace(id)),
        pageInfo: {
          nextCursor: end < ids.length ? String(end) : null,
          prevCursor: null,
          hasMore: end < ids.length,
        },
      };
    };
    const paseo = {
      agents: {
        list: async () => {
          throw new Error("no agents here");
        },
      },
      workspaces: {
        list: async (request: { page?: { cursor?: string }; subscribe?: object }) => {
          requests.push(request);
          const result = page(request.page?.cursor);
          if (!request.subscribe) return result;
          return {
            ...result,
            subscription: {
              subscribe(observer: Observer) {
                observers.push(observer);
                observer.snapshot(result);
                return () => {};
              },
              release: async () => {},
            },
          };
        },
      },
    } as unknown as PaseoApi;
    let latest: ReadonlyMap<string, WorkspaceInfo> = new Map();
    const session = new PaseoSession(paseo, {
      onAgents: () => {},
      onWorkspaces: (workspaces) => (latest = new Map(workspaces)),
      log: () => {},
    });
    session.start();
    await settle();
    expect([...latest.keys()].sort()).toEqual(["w1", "w2", "w3"]);
    expect(requests[0]).toMatchObject({
      filter: { includeBackground: false, includeInternal: false },
      sort: [{ key: "activity_at", direction: "desc" }],
      subscribe: {},
    });
    for (const observer of observers) {
      observer.update({
        type: "workspace_update",
        payload: { kind: "upsert", workspace: workspace("w2", { title: "Renamed" }) },
      });
      observer.update({ type: "workspace_update", payload: { kind: "remove", id: "w3" } });
      observer.update({ type: "agent_update", payload: { kind: "remove", agentId: "w1" } });
    }
    expect([...latest.keys()].sort()).toEqual(["w1", "w2"]);
    expect(latest.get("w2")?.name).toBe("Renamed");
    session.forgetWorkspace("w1");
    expect([...latest.keys()]).toEqual(["w2"]);
    await session.stop();
  });

  it("caches model lists by provider and project directory", async () => {
    const calls: string[] = [];
    const paseo = {
      providers: {
        listModels: async (provider: string, options: { cwd?: string }) => {
          calls.push(`${provider} ${options.cwd}`);
          return { provider, models: [] };
        },
      },
    } as unknown as PaseoApi;
    const session = new PaseoSession(paseo, {
      onAgents: () => {},
      onWorkspaces: () => {},
      log: () => {},
    });
    await session.thinkingChoices(agent({ cwd: "/one" }));
    await session.thinkingChoices(agent({ cwd: "/one" }));
    await session.thinkingChoices(agent({ cwd: "/two" }));
    expect(calls).toEqual(["claude /one", "claude /two"]);
  });

  it("gives the thinking options of an agent whose model is a family name, such as opus", async () => {
    const paseo = {
      providers: { listModels: async () => ({ provider: "claude", models: CLAUDE_MODELS }) },
    } as unknown as PaseoApi;
    const session = new PaseoSession(paseo, {
      onAgents: () => {},
      onWorkspaces: () => {},
      log: () => {},
    });
    const choices = await session.thinkingChoices(
      agent({ model: "opus", thinkingOptionId: "high" }),
    );
    expect(choices?.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(choices?.current).toBe("high");
    // Without a thinking option, the agent is at its model's default.
    expect((await session.thinkingChoices(agent({ model: "opus" })))?.current).toBe("medium");
  });
});

describe("resolveModel", () => {
  const claude = (model: string | null, liveModel: string | null = null) => ({
    provider: "claude",
    model,
    liveModel,
  });
  const id = (model: { id: string } | undefined) => model?.id;

  it("takes the first model of a family name in the provider's order", () => {
    expect(id(resolveModel(CLAUDE_MODELS, claude("opus")))).toBe("claude-opus-5-5");
    expect(id(resolveModel(CLAUDE_MODELS, claude("fable")))).toBe("claude-fable-5-1");
  });

  it("prefers an exact ID, then an alias, to a family", () => {
    expect(id(resolveModel(CLAUDE_MODELS, claude("claude-opus-5")))).toBe("claude-opus-5");
    const aliased = [...CLAUDE_MODELS, { id: "claude-opus-legacy", aliases: ["opus"] }];
    expect(id(resolveModel(aliased, claude("opus")))).toBe("claude-opus-legacy");
  });

  it("prefers the live model from the runtime info to the configured one", () => {
    expect(id(resolveModel(CLAUDE_MODELS, claude("opus", "claude-opus-5")))).toBe("claude-opus-5");
    // A live model that the provider does not list falls back to the configured one.
    expect(id(resolveModel(CLAUDE_MODELS, claude("opus", "claude-unknown-1")))).toBe(
      "claude-opus-5-5",
    );
  });

  it("does not guess beyond its rules", () => {
    // Digits make a name a version, not a family.
    expect(resolveModel(CLAUDE_MODELS, claude("opus5"))).toBeUndefined();
    expect(resolveModel(CLAUDE_MODELS, claude("opus-5-5"))).toBeUndefined();
    // A family name must be a whole part of the ID.
    expect(resolveModel(CLAUDE_MODELS, claude("op"))).toBeUndefined();
    expect(resolveModel(CLAUDE_MODELS, claude("sonnet"))).toBeUndefined();
    // Another provider's prefix does not match.
    expect(resolveModel(CLAUDE_MODELS, { ...claude("opus"), provider: "codex" })).toBeUndefined();
    // A named model that is not found is not the default.
    const withDefault = CLAUDE_MODELS.map((model, index) => ({ ...model, isDefault: index === 2 }));
    expect(resolveModel(withDefault, claude("sonnet"))).toBeUndefined();
  });

  it("takes the default model only when the agent names no model", () => {
    const withDefault = CLAUDE_MODELS.map((model, index) => ({ ...model, isDefault: index === 2 }));
    expect(id(resolveModel(withDefault, claude(null)))).toBe("claude-fable-5-1");
    expect(resolveModel(CLAUDE_MODELS, claude(null))).toBeUndefined();
  });
});
