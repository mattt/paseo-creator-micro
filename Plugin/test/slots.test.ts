import { describe, expect, it } from "vite-plus/test";
import { assignSlots, EMPTY_SLOTS, pinnedSlots, recentSlots, sameSlots } from "../server/slots";
import { agentsByWorkspace, slotCandidates, type SlotCandidate } from "../server/workspaces";
import { agent, workspace } from "./fixtures";

const none = EMPTY_SLOTS;
const candidate = (id: string, activityAt = 1): SlotCandidate => ({ id, activityAt });

describe("assignSlots", () => {
  it("gives free keys to the most recently active workspaces, from key 0", () => {
    const candidates = [candidate("old", 1), candidate("newest", 30), candidate("middle", 20)];
    expect(assignSlots(none, candidates, none)).toEqual([
      "newest",
      "middle",
      "old",
      null,
      null,
      null,
    ]);
  });

  it("takes at most six workspaces", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(`w${index}`, index));
    expect(assignSlots(none, candidates, none)).toEqual(["w7", "w6", "w5", "w4", "w3", "w2"]);
  });

  it("keeps workspaces on their keys when activity changes", () => {
    const previous = ["a", "b", null, null, null, null];
    expect(assignSlots(previous, [candidate("a", 1), candidate("b", 99)], none)).toEqual(previous);
  });

  it("does not move a workspace when a newer one arrives and the keys are full", () => {
    const previous = ["w0", "w1", "w2", "w3", "w4", "w5"];
    const candidates = [...previous.map((id) => candidate(id)), candidate("new", 100)];
    expect(assignSlots(previous, candidates, none)).toEqual(previous);
  });

  it("frees the key of an archived workspace for the next workspace", () => {
    const previous = ["a", "b", "c", null, null, null];
    const groups = agentsByWorkspace([]);
    const candidates = slotCandidates(
      [
        workspace({ id: "a" }),
        workspace({ id: "b", archiving: true }),
        workspace({ id: "c", background: true }),
        workspace({ id: "d", activityAt: 50 }),
        workspace({ id: "e", activityAt: 40 }),
      ],
      groups,
    );
    expect(assignSlots(previous, candidates, none)).toEqual(["a", "d", "e", null, null, null]);
  });

  it("frees the key of a workspace that left the directory", () => {
    expect(assignSlots(["gone", "b", null, null, null, null], [candidate("b")], none)).toEqual([
      null,
      "b",
      null,
      null,
      null,
      null,
    ]);
  });

  it("orders free keys by the latest activity of a workspace's agents", () => {
    const groups = agentsByWorkspace([agent({ workspaceId: "quiet", activityAt: 900 })]);
    const candidates = slotCandidates(
      [workspace({ id: "busy", activityAt: 500 }), workspace({ id: "quiet", activityAt: 10 })],
      groups,
    );
    expect(assignSlots(none, candidates, none).slice(0, 2)).toEqual(["quiet", "busy"]);
  });

  it("moves a pinned workspace to its key", () => {
    const previous = ["a", "b", null, null, null, null];
    const pins = [null, null, null, null, null, "a"];
    expect(assignSlots(previous, [candidate("a"), candidate("b")], pins)).toEqual([
      null,
      "b",
      null,
      null,
      null,
      "a",
    ]);
  });

  it("gives a pinned key to its workspace and finds the displaced workspace a free key", () => {
    const previous = ["a", "b", null, null, null, null];
    const pins = ["b", null, null, null, null, null];
    expect(assignSlots(previous, [candidate("a"), candidate("b")], pins)).toEqual([
      "b",
      "a",
      null,
      null,
      null,
      null,
    ]);
  });

  it("leaves the key of an ineligible pinned workspace to automatic assignment", () => {
    const pins = ["archived", null, null, null, null, null];
    expect(assignSlots(none, [candidate("b")], pins)).toEqual(["b", null, null, null, null, null]);
  });

  it("uses the first pin when a workspace is pinned to two keys", () => {
    const pins = [null, "a", "a", null, null, null];
    expect(assignSlots(none, [candidate("a")], pins)).toEqual([null, "a", null, null, null, null]);
  });

  it("orders workspaces with the same activity by ID", () => {
    const candidates = [candidate("b", 5), candidate("a", 5)];
    expect(assignSlots(none, candidates, none).slice(0, 2)).toEqual(["a", "b"]);
  });
});

describe("sameSlots", () => {
  it("compares keys in order", () => {
    expect(sameSlots(["a", null], ["a", null])).toBe(true);
    expect(sameSlots(["a", null], [null, "a"])).toBe(false);
  });
});

describe("pinnedSlots", () => {
  it("shows only eligible pinned workspaces, each once, and leaves the other keys empty", () => {
    const pins = ["a", null, "gone", "b", "a", null];
    expect(pinnedSlots([candidate("a"), candidate("b"), candidate("c")], pins)).toEqual([
      "a",
      null,
      null,
      "b",
      null,
      null,
    ]);
    expect(pinnedSlots([candidate("a")], none)).toEqual(none);
  });
});

describe("recentSlots", () => {
  it("puts the six most recently active agents on keys, the newest on the lowest free key", () => {
    const candidates = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) => candidate(id, index));
    expect(recentSlots(none, candidates)).toEqual(["g", "f", "e", "d", "c", "b"]);
  });

  it("keeps each agent on its key while it stays among the six, and gives a leaver's key to the newcomer", () => {
    const previous = ["g", "f", "e", "d", "c", "b"];
    const candidates = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) =>
      candidate(id, id === "a" ? 100 : index),
    );
    expect(recentSlots(previous, candidates)).toEqual(["g", "f", "e", "d", "c", "a"]);
    // Activity order among the six does not move them.
    const busier = candidates.map((each) => (each.id === "c" ? candidate("c", 200) : each));
    expect(recentSlots(previous.slice(0, 5).concat("a"), busier)).toEqual([
      "g",
      "f",
      "e",
      "d",
      "c",
      "a",
    ]);
  });
});
