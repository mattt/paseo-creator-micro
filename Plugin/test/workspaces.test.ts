import { deriveAgentStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vite-plus/test";
import type { AgentInfo } from "../server/agents";
import {
  agentsByWorkspace,
  agentState,
  isWorkspaceEligible,
  needsInput,
  relevantAgent,
  slotCandidates,
  toWorkspaceInfo,
  workspaceState,
  type WorkspaceState,
} from "../server/workspaces";
import { agent, permission, workspace } from "./fixtures";

const descriptor = {
  id: "wks_1",
  projectId: "proj_1",
  projectDisplayName: "paseo-creator-micro",
  projectRootPath: "/tmp/paseo-creator-micro",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "example/workspace-keys",
  title: null,
  archivingAt: null,
  status: "done",
  statusEnteredAt: null,
  activityAt: "2026-10-27T18:00:00.000Z",
  createdAt: "2026-10-27T17:00:00.000Z",
  scripts: [],
  gitRuntime: null,
  githubRuntime: null,
} as unknown as WorkspaceDescriptorPayload;

describe("toWorkspaceInfo", () => {
  it("keeps what the plugin needs from a descriptor", () => {
    expect(toWorkspaceInfo(descriptor)).toEqual({
      id: "wks_1",
      name: "example/workspace-keys",
      projectId: "proj_1",
      projectName: "paseo-creator-micro",
      activityAt: Date.parse("2026-10-27T18:00:00.000Z"),
      archiving: false,
      background: false,
      internal: false,
    });
  });

  it("prefers the title and falls back to the creation time", () => {
    const info = toWorkspaceInfo({
      ...descriptor,
      title: " Workspace keys ",
      activityAt: null,
      archivingAt: "2026-10-27T19:00:00.000Z",
      background: true,
    });
    expect(info).toMatchObject({
      name: "Workspace keys",
      activityAt: Date.parse("2026-10-27T17:00:00.000Z"),
      archiving: true,
      background: true,
    });
  });
});

describe("isWorkspaceEligible", () => {
  it("excludes workspaces being archived, background workspaces, and internal ones", () => {
    expect(isWorkspaceEligible(workspace())).toBe(true);
    expect(isWorkspaceEligible(workspace({ archiving: true }))).toBe(false);
    expect(isWorkspaceEligible(workspace({ background: true }))).toBe(false);
    expect(isWorkspaceEligible(workspace({ internal: true }))).toBe(false);
  });
});

/** One agent in each state. */
const IN_STATE: Readonly<Record<WorkspaceState, () => AgentInfo>> = {
  failed: () => agent({ status: "error" }),
  needsInput: () => agent({ pendingPermissions: [permission()] }),
  running: () => agent({ status: "running" }),
  done: () => agent({ requiresAttention: true, attentionReason: "finished" }),
  idle: () => agent(),
};

const ORDER: readonly WorkspaceState[] = ["failed", "needsInput", "running", "done", "idle"];

describe("agentState", () => {
  it.each([
    ["an error status", agent({ status: "error" }), "failed"],
    [
      "an unread failed turn",
      agent({ requiresAttention: true, attentionReason: "error" }),
      "failed",
    ],
    [
      "an error with a pending request",
      agent({ status: "error", pendingPermissions: [permission()] }),
      "failed",
    ],
    ["a pending request", agent({ pendingPermissions: [permission()] }), "needsInput"],
    [
      "a pending question while running",
      agent({ status: "running", pendingPermissions: [permission({ kind: "question" })] }),
      "needsInput",
    ],
    [
      "unread permission attention",
      agent({ requiresAttention: true, attentionReason: "permission" }),
      "needsInput",
    ],
    ["a running turn", agent({ status: "running" }), "running"],
    [
      "a running turn after an unread finished one",
      agent({ status: "running", requiresAttention: true, attentionReason: "finished" }),
      "running",
    ],
    ["a starting agent", agent({ status: "initializing" }), "running"],
    [
      "an unread finished turn",
      agent({ requiresAttention: true, attentionReason: "finished" }),
      "done",
    ],
    ["a finished turn that was read", agent({ attentionReason: "finished" }), "idle"],
    ["a failed turn that was read", agent({ attentionReason: "error" }), "idle"],
    ["attention without a reason", agent({ requiresAttention: true }), "idle"],
    ["an agent that never had a prompt", agent(), "idle"],
    [
      "permission attention that was read, with no request left",
      agent({ attentionReason: "permission" }),
      "idle",
    ],
  ] as const)("shows %s as %s", (_name, subject, expected) => {
    expect(agentState(subject)).toBe(expected);
  });

  it("differs from Paseo's bucketing only in the documented places", () => {
    const paseo = (subject: AgentInfo) =>
      deriveAgentStateBucket({
        status: subject.status,
        pendingPermissionCount: subject.pendingPermissions.length,
        requiresAttention: subject.requiresAttention,
        attentionReason: subject.attentionReason,
      });
    // Paseo puts needs input before failed.
    const both = agent({ status: "error", pendingPermissions: [permission()] });
    expect([agentState(both), paseo(both)]).toEqual(["failed", "needs_input"]);
    // Paseo files a starting agent under done.
    const starting = agent({ status: "initializing" });
    expect([agentState(starting), paseo(starting)]).toEqual(["running", "done"]);
    // Paseo keeps unread finished agents apart as attention.
    const unread = agent({ requiresAttention: true, attentionReason: "finished" });
    expect([agentState(unread), paseo(unread)]).toEqual(["done", "attention"]);
    // Paseo files an idle agent, read or never prompted, under done.
    expect([agentState(agent()), paseo(agent())]).toEqual(["idle", "done"]);
    // Otherwise they agree.
    expect(paseo(IN_STATE.failed())).toBe("failed");
    expect(paseo(IN_STATE.needsInput())).toBe("needs_input");
    expect(paseo(IN_STATE.running())).toBe("running");
  });
});

describe("workspaceState", () => {
  it("is idle without agents", () => {
    expect(workspaceState([])).toBe("idle");
  });

  const pairs = ORDER.flatMap((first) => ORDER.map((second) => [first, second] as const));
  it.each(pairs)("shows %s and %s as the more urgent one", (first, second) => {
    const expected = ORDER[Math.min(ORDER.indexOf(first), ORDER.indexOf(second))];
    expect(workspaceState([IN_STATE[first](), IN_STATE[second]()])).toBe(expected);
  });

  it("shows failed over every other state at once", () => {
    const agents = ORDER.map((state) => IN_STATE[state]());
    expect(workspaceState(agents)).toBe("failed");
    expect(workspaceState(agents.slice(1))).toBe("needsInput");
    expect(workspaceState(agents.slice(2))).toBe("running");
    expect(workspaceState(agents.slice(3))).toBe("done");
    expect(workspaceState(agents.slice(4))).toBe("idle");
  });
});

describe("needsInput", () => {
  it("counts pending requests and unread permission attention", () => {
    expect(needsInput(IN_STATE.needsInput())).toBe(true);
    expect(needsInput(agent({ requiresAttention: true, attentionReason: "permission" }))).toBe(
      true,
    );
    expect(needsInput(agent({ requiresAttention: true, attentionReason: "finished" }))).toBe(false);
    expect(needsInput(IN_STATE.failed())).toBe(false);
  });
});

describe("relevantAgent", () => {
  const recent = agent({ id: "recent", activityAt: 900 });
  const running = agent({ id: "running", status: "running", activityAt: 500 });
  const broken = agent({ id: "broken", status: "error", activityAt: 100 });
  const asking = agent({ id: "asking", pendingPermissions: [permission()], activityAt: 50 });

  it("picks an agent that needs input first", () => {
    expect(relevantAgent([recent, running, broken, asking])?.id).toBe("asking");
  });

  it("picks a failed agent when none needs input", () => {
    expect(relevantAgent([recent, running, broken])?.id).toBe("broken");
  });

  it("otherwise picks the most recently active agent", () => {
    expect(relevantAgent([running, recent])?.id).toBe("recent");
  });

  it("picks the agent that has waited longest within a tier", () => {
    const later = agent({
      id: "later",
      pendingPermissions: [permission()],
      requiresAttention: true,
      attentionReason: "permission",
      attentionAt: 300,
      activityAt: 300,
    });
    const earlier = agent({
      id: "earlier",
      requiresAttention: true,
      attentionReason: "permission",
      attentionAt: 200,
      activityAt: 999,
    });
    expect(relevantAgent([later, earlier])?.id).toBe("earlier");
    const failedLater = agent({ id: "b", status: "error", activityAt: 20 });
    const failedEarlier = agent({ id: "a", status: "error", activityAt: 10 });
    expect(relevantAgent([failedLater, failedEarlier])?.id).toBe("a");
  });

  it("returns null without agents", () => {
    expect(relevantAgent([])).toBeNull();
  });
});

describe("agentsByWorkspace and slotCandidates", () => {
  it("groups agents and leaves out agents without a workspace", () => {
    const groups = agentsByWorkspace([
      agent({ id: "a", workspaceId: "w1" }),
      agent({ id: "b", workspaceId: "w2" }),
      agent({ id: "c", workspaceId: "w1" }),
      agent({ id: "loose" }),
    ]);
    expect([...groups.keys()].sort()).toEqual(["w1", "w2"]);
    expect(groups.get("w1")?.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("takes eligible workspaces with the latest activity of the workspace or its agents", () => {
    const groups = agentsByWorkspace([
      agent({ workspaceId: "w1", activityAt: 5_000 }),
      agent({ workspaceId: "w2", activityAt: 10 }),
    ]);
    const candidates = slotCandidates(
      [
        workspace({ id: "w1", activityAt: 100 }),
        workspace({ id: "w2", activityAt: 300 }),
        workspace({ id: "w3", activityAt: 200 }),
        workspace({ id: "gone", archiving: true, activityAt: 9_999 }),
      ],
      groups,
    );
    expect(candidates).toEqual([
      { id: "w1", activityAt: 5_000 },
      { id: "w2", activityAt: 300 },
      { id: "w3", activityAt: 200 },
    ]);
  });
});

describe("subagents", () => {
  const sub = (overrides: Partial<AgentInfo> = {}) =>
    agent({ parentAgentId: "parent", ...overrides });
  const failedSub = sub({ status: "error" });
  const askingSub = sub({ pendingPermissions: [permission()] });
  const permissionSub = sub({ requiresAttention: true, attentionReason: "permission" });
  const doneSub = sub({ requiresAttention: true, attentionReason: "finished" });

  it("count only as running or idle by default", () => {
    expect([failedSub, askingSub, permissionSub, doneSub].map((each) => agentState(each))).toEqual([
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
    expect(agentState(sub({ status: "running", pendingPermissions: [permission()] }))).toBe(
      "running",
    );
    expect(agentState(sub({ status: "initializing" }))).toBe("running");
  });

  it("count like other agents when included", () => {
    expect(
      [failedSub, askingSub, permissionSub, doneSub].map((each) => agentState(each, true)),
    ).toEqual(["failed", "needsInput", "needsInput", "done"]);
  });

  it("leave a workspace whose only waiting agent is a subagent idle, or running while it runs", () => {
    expect(workspaceState([askingSub, agent()])).toBe("idle");
    expect(workspaceState([askingSub, sub({ status: "running" })])).toBe("running");
    expect(workspaceState([askingSub, failedSub], true)).toBe("failed");
    expect(
      workspaceState([askingSub, agent({ requiresAttention: true, attentionReason: "finished" })]),
    ).toBe("done");
  });
});
