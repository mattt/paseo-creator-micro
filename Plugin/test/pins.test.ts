import { describe, expect, it } from "vite-plus/test";
import { changePins, parseKeyNumber, pinWorkspace, unpinKey, unpinWorkspace } from "../client/pins";
import { DEFAULT_SETTINGS } from "../shared/settings";

const empty = DEFAULT_SETTINGS.pins;

describe("pins", () => {
  it("pins a workspace to one key only", () => {
    const once = pinWorkspace(empty, "a", 2);
    expect(once).toEqual([null, null, "a", null, null, null]);
    expect(pinWorkspace(once, "a", 4)).toEqual([null, null, null, null, "a", null]);
    expect(pinWorkspace(once, "b", 2)).toEqual([null, null, "b", null, null, null]);
  });

  it("refuses keys outside 0–5", () => {
    expect(() => pinWorkspace(empty, "a", 6)).toThrow("1 to 6");
  });

  it("unpins by workspace or by key", () => {
    const pins = ["a", null, "b", null, null, null];
    expect(unpinWorkspace(pins, "b")).toEqual(["a", null, null, null, null, null]);
    expect(unpinKey(pins, 0)).toEqual([null, null, "b", null, null, null]);
  });

  it("reads key numbers from 1 to 6", () => {
    expect(parseKeyNumber(" 3 ")).toBe(2);
    expect(() => parseKeyNumber("7")).toThrow("/keypad-pin-workspace 3");
    expect(() => parseKeyNumber("")).toThrow();
  });
});

describe("changePins", () => {
  function store(conflicts: number) {
    let revision = 1;
    let values: unknown = { pins: ["x", null, null, null, null, null] };
    let remaining = conflicts;
    const rpc = async (contract: { name: string }, input: unknown) => {
      if (contract.name.endsWith("read")) {
        return { status: "ready", revision: String(revision), values };
      }
      const write = input as { revision: string; values: unknown };
      if (remaining > 0 || write.revision !== String(revision)) {
        remaining -= 1;
        revision += 1;
        return { status: "conflict", error: "stale" };
      }
      values = write.values;
      revision += 1;
      return { status: "saved", revision: String(revision), values };
    };
    return { rpc, read: () => values as { pins: unknown[] } };
  }

  it("writes the changed pins with the revision it read", async () => {
    const settings = store(0);
    await changePins(settings.rpc as never, (pins) => pinWorkspace(pins, "a", 1));
    expect(settings.read().pins).toEqual(["x", "a", null, null, null, null]);
  });

  it("retries after a conflict", async () => {
    const settings = store(2);
    await changePins(settings.rpc as never, (pins) => unpinWorkspace(pins, "x"));
    expect(settings.read().pins).toEqual([null, null, null, null, null, null]);
  });

  it("gives up after repeated conflicts", async () => {
    const settings = store(5);
    await expect(changePins(settings.rpc as never, (pins) => pins)).rejects.toThrow("Try again");
  });
});
