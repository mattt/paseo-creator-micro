import {
  getParentAgentIdFromLabels,
  PARENT_AGENT_ID_LABEL as PROTOCOL_PARENT_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vite-plus/test";
import {
  isEligible,
  isKeypadTarget,
  isSubagent,
  PARENT_AGENT_ID_LABEL,
  parentAgentIdFrom,
  toAgentInfo,
} from "../server/agents";
import { agent } from "./fixtures";

const snapshot = {
  id: "35585390-8b2c-466a-9cfb-697fcc7052c1",
  provider: "claude",
  cwd: "/tmp/release",
  workspaceId: "wks_1",
  model: "claude-opus-5-5",
  thinkingOptionId: "medium",
  effectiveThinkingOptionId: "high",
  createdAt: "2026-10-26T19:01:10.055Z",
  updatedAt: "2026-10-26T21:20:51.490Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {},
  currentModeId: "auto",
  availableModes: [],
  pendingPermissions: [
    {
      id: "perm-1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run tests",
      actions: [
        { id: "deny", label: "Deny", behavior: "deny" },
        { id: "once", label: "Allow once", behavior: "allow", variant: "secondary" },
        { id: "always", label: "Always allow", behavior: "allow", variant: "primary" },
      ],
    },
  ],
  persistence: null,
  title: "Release measurements",
  labels: { "paseo.parent-server-id": "srv_abc" },
  requiresAttention: true,
  attentionReason: "finished",
  attentionTimestamp: "2026-10-26T21:30:00.000Z",
  archivedAt: null,
} as unknown as AgentSnapshotPayload;

describe("toAgentInfo", () => {
  it("keeps what the plugin needs from a snapshot", () => {
    const info = toAgentInfo(snapshot);
    expect(info).toMatchObject({
      id: "35585390-8b2c-466a-9cfb-697fcc7052c1",
      workspaceId: "wks_1",
      title: "Release measurements",
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "high",
      requiresAttention: true,
      attentionReason: "finished",
      attentionAt: Date.parse("2026-10-26T21:30:00.000Z"),
      activityAt: Date.parse("2026-10-26T21:30:00.000Z"),
      archived: false,
      internal: false,
      labeledServerId: "srv_abc",
    });
    expect(info.pendingPermissions).toEqual([
      {
        id: "perm-1",
        kind: "tool",
        title: "Run tests",
        allowActionId: "always",
        denyActionId: "deny",
      },
    ]);
  });

  it("keeps the live model from the runtime info, or null without one", () => {
    expect(toAgentInfo(snapshot).liveModel).toBeNull();
    const live = {
      ...snapshot,
      model: "opus",
      runtimeInfo: { provider: "claude", sessionId: "s1", model: "claude-opus-5-5" },
    } as AgentSnapshotPayload;
    expect(toAgentInfo(live)).toMatchObject({ model: "opus", liveModel: "claude-opus-5-5" });
  });

  it("tolerates a missing workspace", () => {
    const { workspaceId: _omitted, ...rest } = snapshot;
    expect(toAgentInfo(rest as AgentSnapshotPayload).workspaceId).toBeNull();
  });

  it("has no parent agent without Paseo's parent label", () => {
    expect(toAgentInfo(snapshot).parentAgentId).toBeNull();
  });

  it("reads the agent that started it from Paseo's parent label", () => {
    const labels = { ...snapshot.labels, "paseo.parent-agent-id": "0b95b862-ce20" };
    expect(toAgentInfo({ ...snapshot, labels }).parentAgentId).toBe("0b95b862-ce20");
  });

  it("marks archived agents", () => {
    const archived = { ...snapshot, archivedAt: "2026-10-26T22:00:00.000Z" };
    expect(toAgentInfo(archived).archived).toBe(true);
  });
});

describe("isEligible", () => {
  it("excludes archived, internal, and closed agents", () => {
    expect(isEligible(agent())).toBe(true);
    expect(isEligible(agent({ archived: true }))).toBe(false);
    expect(isEligible(agent({ internal: true }))).toBe(false);
    expect(isEligible(agent({ status: "closed" }))).toBe(false);
  });
});

describe("parentAgentIdFrom", () => {
  it("reads the label that Paseo's protocol defines, as the protocol reads it", () => {
    expect(PARENT_AGENT_ID_LABEL).toBe(PROTOCOL_PARENT_LABEL);
    const cases: Record<string, string>[] = [
      {},
      { [PARENT_AGENT_ID_LABEL]: "parent" },
      { [PARENT_AGENT_ID_LABEL]: "  parent  " },
      { [PARENT_AGENT_ID_LABEL]: "   " },
      { [PARENT_AGENT_ID_LABEL]: "" },
      { "paseo.parent-server-id": "srv_abc" },
    ];
    for (const labels of cases) {
      expect(parentAgentIdFrom(labels)).toBe(getParentAgentIdFromLabels(labels));
    }
    expect(parentAgentIdFrom({ [PARENT_AGENT_ID_LABEL]: "  parent  " })).toBe("parent");
  });
});

describe("isKeypadTarget", () => {
  it("leaves out subagents unless they are included", () => {
    const mine = agent();
    const sub = agent({ parentAgentId: "parent" });
    expect([isSubagent(mine), isSubagent(sub)]).toEqual([false, true]);
    expect(isKeypadTarget(mine, false)).toBe(true);
    expect(isKeypadTarget(sub, false)).toBe(false);
    expect(isKeypadTarget(sub, true)).toBe(true);
  });
});
