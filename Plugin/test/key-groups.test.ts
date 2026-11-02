import { describe, expect, it } from "vite-plus/test";
import { groupLeader, groupOf, groupsAreDisjoint, joinKeys } from "../shared/key-groups";

describe("key groups", () => {
  const groups = [["ACT11", "ACT10"]] as const;

  it("finds an input's group in key order, else the input alone", () => {
    expect(groupOf(groups, "ACT11")).toEqual(["ACT10", "ACT11"]);
    expect(groupOf(groups, "ACT10")).toEqual(["ACT10", "ACT11"]);
    expect(groupOf(groups, "ACT12")).toEqual(["ACT12"]);
    expect(groupOf(groups, "dialPress")).toEqual(["dialPress"]);
  });

  it("leads a group with its first key", () => {
    expect(groupLeader(groups, "ACT11")).toBe("ACT10");
    expect(groupLeader(groups, "ACT12")).toBe("ACT12");
    expect(groupLeader([], "ACT11")).toBe("ACT11");
  });

  it("joins two keys and the groups they are in", () => {
    expect(joinKeys([], "ACT10", "ACT11")).toEqual([["ACT10", "ACT11"]]);
    expect(joinKeys(groups, "ACT11", "ACT12")).toEqual([["ACT10", "ACT11", "ACT12"]]);
    expect(joinKeys([["ACT06", "ACT07"], ...groups], "ACT08", "ACT09")).toEqual([
      ["ACT06", "ACT07"],
      ["ACT11", "ACT10"],
      ["ACT08", "ACT09"],
    ]);
  });

  it("checks that no key is in two groups", () => {
    expect(
      groupsAreDisjoint([
        ["ACT10", "ACT11"],
        ["ACT06", "ACT07"],
      ]),
    ).toBe(true);
    expect(
      groupsAreDisjoint([
        ["ACT10", "ACT11"],
        ["ACT11", "ACT12"],
      ]),
    ).toBe(false);
    expect(groupsAreDisjoint([["ACT10", "ACT10"]])).toBe(false);
  });
});
