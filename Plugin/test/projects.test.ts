import { describe, expect, it } from "vite-plus/test";
import { adjacentProject, byRecentActivity, projectOrder } from "../server/projects";
import { agent, workspace } from "./fixtures";

const inProject = (id: string, projectId: string, projectName = projectId, activityAt = 1_000) =>
  workspace({ id, projectId, projectName, activityAt });

describe("projectOrder", () => {
  it("orders projects by name, ignoring case, with numbers in numeric order, then by ID", () => {
    const projects = projectOrder([
      inProject("w1", "p-zeta", "zeta"),
      inProject("w2", "p-alpha", "Alpha"),
      inProject("w3", "p-beta-10", "beta 10"),
      inProject("w4", "p-beta-9", "beta 9"),
      inProject("w5", "p-alpha-2", "alpha"),
      inProject("w6", "p-alpha", "Alpha"),
    ]);
    expect(projects.map((project) => project.id)).toEqual([
      "p-alpha",
      "p-alpha-2",
      "p-beta-9",
      "p-beta-10",
      "p-zeta",
    ]);
    expect(projects[0]?.workspaces.map((each) => each.id)).toEqual(["w2", "w6"]);
  });

  it("has no entry for a project without workspaces", () => {
    expect(projectOrder([])).toEqual([]);
  });
});

describe("adjacentProject", () => {
  const projects = projectOrder(["a", "b", "c"].map((id) => inProject(`w-${id}`, id)));

  it("steps to the next or previous project, wrapping around", () => {
    expect(adjacentProject(projects, "a", 1)?.id).toBe("b");
    expect(adjacentProject(projects, "c", 1)?.id).toBe("a");
    expect(adjacentProject(projects, "a", -1)?.id).toBe("c");
  });

  it("starts at the first or last project without a current one", () => {
    expect(adjacentProject(projects, null, 1)?.id).toBe("a");
    expect(adjacentProject(projects, "gone", -1)?.id).toBe("c");
  });

  it("goes nowhere with fewer than two projects", () => {
    expect(adjacentProject(projects.slice(0, 1), null, 1)).toBeNull();
    expect(adjacentProject([], null, -1)).toBeNull();
  });
});

describe("byRecentActivity", () => {
  it("orders workspaces by their own and their agents' latest activity", () => {
    const workspaces = [
      inProject("quiet", "p", "p", 300),
      inProject("busy", "p", "p", 100),
      inProject("old", "p", "p", 200),
    ];
    const agents = [agent({ workspaceId: "busy", activityAt: 900 })];
    expect(byRecentActivity(workspaces, agents).map((each) => each.id)).toEqual([
      "busy",
      "quiet",
      "old",
    ]);
  });
});
