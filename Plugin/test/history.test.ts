import { describe, expect, it } from "vite-plus/test";
import { MAX_HISTORY, NavigationHistory, type Place } from "../server/history";

const always = () => true;

/** A place in workspace `id` with an agent of the same name. */
const at = (id: string): Place => ({ workspaceId: id, agentId: id });

function historyOf(...ids: string[]): NavigationHistory {
  const history = new NavigationHistory();
  for (const id of ids) history.visit(at(id));
  return history;
}

const ids = (history: NavigationHistory) => history.list().map((place) => place.agentId);

describe("NavigationHistory", () => {
  it("records each place opened, but not the current one again", () => {
    expect(ids(historyOf("a", "b", "b", "a"))).toEqual(["a", "b", "a"]);
  });

  it("records two agents of one workspace as two places", () => {
    const history = new NavigationHistory();
    history.visit({ workspaceId: "w", agentId: "a" });
    history.visit({ workspaceId: "w", agentId: "b" });
    expect(history.back(always)).toEqual({ workspaceId: "w", agentId: "a" });
  });

  it("steps back like a browser, further with each step, and keeps the places ahead", () => {
    const history = historyOf("a", "b", "c");
    expect(history.back(always)).toEqual(at("b"));
    expect(history.back(always)).toEqual(at("a"));
    expect(history.back(always)).toBeNull();
    expect(history.current()).toEqual(at("a"));
    expect(ids(history)).toEqual(["a", "b", "c"]);
  });

  it("steps forward again after stepping back", () => {
    const history = historyOf("a", "b", "c");
    history.back(always);
    history.back(always);
    expect(history.forward(always)).toEqual(at("b"));
    expect(history.forward(always)).toEqual(at("c"));
    expect(history.forward(always)).toBeNull();
    expect(history.current()).toEqual(at("c"));
  });

  it("drops the places ahead when a new place opens after a step back", () => {
    const history = historyOf("a", "b", "c");
    history.back(always);
    history.visit(at("d"));
    expect(ids(history)).toEqual(["a", "b", "d"]);
    expect(history.canGoForward(always)).toBe(false);
    expect(history.back(always)).toEqual(at("b"));
  });

  it("keeps the places ahead when the current place opens again", () => {
    const history = historyOf("a", "b");
    history.back(always);
    history.visit(at("a"));
    expect(history.forward(always)).toEqual(at("b"));
  });

  it("skips places that are no longer available, both ways", () => {
    const history = historyOf("a", "gone", "c");
    const available = (place: Place) => place.agentId !== "gone";
    expect(history.back(available)).toEqual(at("a"));
    expect(history.forward(available)).toEqual(at("c"));
  });

  it("says whether it can step, without stepping", () => {
    const history = historyOf("gone", "c");
    const available = (place: Place) => place.agentId !== "gone";
    expect(history.canGoBack(available)).toBe(false);
    expect(history.back(available)).toBeNull();
    expect(history.current()).toEqual(at("c"));
    expect(history.canGoBack(always)).toBe(true);
    expect(history.canGoForward(always)).toBe(false);
    expect(new NavigationHistory().back(always)).toBeNull();
    expect(new NavigationHistory().canGoForward(always)).toBe(false);
  });

  it("keeps a bounded number of places", () => {
    const history = historyOf(
      ...Array.from({ length: MAX_HISTORY + 5 }, (_, index) => `w${index}`),
    );
    expect(history.list()).toHaveLength(MAX_HISTORY);
    expect(history.list()[0]?.agentId).toBe("w5");
    expect(history.current()?.agentId).toBe(`w${MAX_HISTORY + 4}`);
  });
});
