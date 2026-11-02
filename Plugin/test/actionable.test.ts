import { describe, expect, it } from "vite-plus/test";
import { ActionableWalk, actionState, requiresAction, waitingSince } from "../server/actionable";
import type { AgentInfo } from "../server/agents";
import { agent, permission } from "./fixtures";

const unseen = () => Number.POSITIVE_INFINITY;

const unread = (id: string, attentionAt: number) =>
  agent({ id, requiresAttention: true, attentionReason: "finished", attentionAt });

/** Presses the key `count` times and returns the IDs it opened, passing on the last one. */
function mash(walk: ActionableWalk, agents: () => readonly AgentInfo[], count: number) {
  const ids: string[] = [];
  let opened: string | null = null;
  for (let press = 0; press < count; press += 1) {
    const next = walk.next(agents(), opened, unseen);
    if (next) opened = next.id;
    ids.push(next?.id ?? "none");
  }
  return ids;
}

describe("requiresAction", () => {
  it("counts requests, failures, and unread results, and not running or read agents", () => {
    expect(requiresAction(agent({ pendingPermissions: [permission()] }))).toBe(true);
    expect(requiresAction(agent({ requiresAttention: true, attentionReason: "permission" }))).toBe(
      true,
    );
    expect(requiresAction(agent({ status: "error" }))).toBe(true);
    expect(requiresAction(agent({ requiresAttention: true, attentionReason: "error" }))).toBe(true);
    expect(requiresAction(unread("u", 1))).toBe(true);
    expect(requiresAction(agent({ status: "running" }))).toBe(false);
    expect(requiresAction(agent())).toBe(false);
  });
});

describe("actionState", () => {
  it("orders failed, then needs input, then an unread result, and is null without action", () => {
    expect(actionState(agent({ status: "error", pendingPermissions: [permission()] }))).toBe(
      "failed",
    );
    expect(actionState(agent({ pendingPermissions: [permission()] }))).toBe("needsInput");
    expect(actionState(unread("u", 1))).toBe("done");
    expect(actionState({ ...unread("r", 1), status: "running" })).toBe("done");
    expect(actionState(agent({ status: "running" }))).toBeNull();
  });
});

describe("waitingSince", () => {
  it("uses the attention time, else the first request seen, else the latest activity", () => {
    expect(waitingSince(unread("u", 5), unseen)).toBe(5);
    const asking = agent({
      pendingPermissions: [permission({ id: "r1" }), permission({ id: "r2" })],
      activityAt: 50,
    });
    expect(waitingSince(asking, (_, requestId) => (requestId === "r2" ? 7 : 9))).toBe(7);
    expect(waitingSince(asking, unseen)).toBe(50);
    expect(waitingSince(agent({ status: "error", activityAt: 40 }), unseen)).toBe(40);
  });
});

describe("ActionableWalk", () => {
  it("returns null when no agent requires action", () => {
    expect(new ActionableWalk().next([agent()], null, unseen)).toBeNull();
  });

  it("opens every agent once in a round, the one that waited longest first", () => {
    const agents = [unread("c", 3), unread("a", 1), unread("b", 2)];
    expect(mash(new ActionableWalk(), () => agents, 7)).toEqual([
      "a",
      "b",
      "c",
      "a",
      "b",
      "c",
      "a",
    ]);
  });

  it("never opens the agent it opened last again while another agent requires action", () => {
    const walk = new ActionableWalk();
    const agents = [unread("a", 1), unread("b", 2)];
    expect(walk.next(agents, "a", unseen)?.id).toBe("b");
    expect(walk.next(agents, "b", unseen)?.id).toBe("a");
    expect(walk.next(agents, "a", unseen)?.id).toBe("b");
  });

  it("opens the only agent that requires action again", () => {
    const walk = new ActionableWalk();
    const agents = [unread("a", 1)];
    expect(walk.next(agents, null, unseen)?.id).toBe("a");
    expect(walk.next(agents, "a", unseen)?.id).toBe("a");
  });

  it("opens an agent that starts to require action mid-round before starting over", () => {
    const walk = new ActionableWalk();
    let agents = [unread("a", 1), unread("b", 2), unread("c", 3)];
    expect(walk.next(agents, null, unseen)?.id).toBe("a");
    expect(walk.next(agents, "a", unseen)?.id).toBe("b");
    agents = [...agents, unread("d", 4)];
    expect(walk.next(agents, "b", unseen)?.id).toBe("c");
    expect(walk.next(agents, "c", unseen)?.id).toBe("d");
    expect(walk.next(agents, "d", unseen)?.id).toBe("a");
  });

  it("treats a newer result or a new request of an opened agent as new", () => {
    const walk = new ActionableWalk();
    let agents = [unread("a", 1), unread("b", 2), unread("c", 3)];
    expect(walk.next(agents, null, unseen)?.id).toBe("a");
    expect(walk.next(agents, "a", unseen)?.id).toBe("b");
    agents = [unread("a", 10), agents[1] as AgentInfo, agents[2] as AgentInfo];
    expect(walk.next(agents, "b", unseen)?.id).toBe("c");
    expect(walk.next(agents, "c", unseen)?.id).toBe("a");

    const asking = agent({ id: "x", pendingPermissions: [permission({ id: "r1" })] });
    const others = [unread("y", 1), unread("z", 2000)];
    const requests = new ActionableWalk();
    expect(requests.next([asking, ...others], null, unseen)?.id).toBe("y");
    expect(requests.next([asking, ...others], "y", unseen)?.id).toBe("x");
    const again = { ...asking, pendingPermissions: [permission({ id: "r2" })] };
    expect(requests.next([again, ...others], "x", unseen)?.id).toBe("z");
    expect(requests.next([again, ...others], "z", unseen)?.id).toBe("x");
  });

  it("forgets an agent that stops requiring action, so it is new when it requires action again", () => {
    const walk = new ActionableWalk();
    const a = unread("a", 1);
    const b = unread("b", 2);
    const c = unread("c", 3);
    expect(walk.next([a, b, c], null, unseen)?.id).toBe("a");
    expect(walk.next([b, c], "a", unseen)?.id).toBe("b");
    expect(walk.next([a, b, c], "b", unseen)?.id).toBe("a");
    expect(walk.next([a, b, c], "a", unseen)?.id).toBe("c");
  });

  it("peeks at the agent that the next press opens without recording it", () => {
    const walk = new ActionableWalk();
    const agents = [unread("c", 3), unread("a", 1), unread("b", 2)];
    let opened: string | null = null;
    for (let press = 0; press < 7; press += 1) {
      const peeked = walk.peek(agents, opened, unseen);
      expect(walk.peek(agents, opened, unseen)).toBe(peeked);
      const next = walk.next(agents, opened, unseen);
      expect(next).toBe(peeked);
      opened = next?.id ?? null;
    }
    expect(new ActionableWalk().peek([agent()], null, unseen)).toBeNull();
  });

  it("peeks past the agent that the keypad opened last, as the next press does", () => {
    const walk = new ActionableWalk();
    const agents = [unread("a", 1), unread("b", 2)];
    expect(walk.next(agents, null, unseen)?.id).toBe("a");
    expect(walk.peek(agents, "a", unseen)?.id).toBe("b");
    expect(walk.peek([unread("a", 1)], "a", unseen)?.id).toBe("a");
  });
});
