import type { AgentInfo } from "./agents";
import type { WorkspaceInfo } from "./workspaces";

/** A project with workspaces that can have a key, for "previous project" and "next project". */
export interface ProjectEntry {
  readonly id: string;
  readonly name: string;
  readonly workspaces: readonly WorkspaceInfo[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * The projects of `workspaces` in a stable order: by name, ignoring case and accents,
 * with numbers in numeric order, then by project ID.
 * Pass only the eligible workspaces (`isWorkspaceEligible`), so that a project whose
 * workspaces are all archived, background, or internal has no entry.
 *
 * Paseo exposes no sidebar order and no creation time for projects:
 * `paseo.projects.list` returns each project's ID, key, names, root path, kind, and a sync
 * sequence, and `paseo.workspaces.list` sorts only by name, status, activity, or project ID
 * (`@getpaseo/protocol` 0.13.0, checked 2026-10-29). The name is the order that the user can see.
 */
export function projectOrder(workspaces: readonly WorkspaceInfo[]): ProjectEntry[] {
  const projects = new Map<string, { id: string; name: string; workspaces: WorkspaceInfo[] }>();
  for (const workspace of workspaces) {
    const project = projects.get(workspace.projectId);
    if (project) project.workspaces.push(workspace);
    else {
      projects.set(workspace.projectId, {
        id: workspace.projectId,
        name: workspace.projectName,
        workspaces: [workspace],
      });
    }
  }
  return [...projects.values()].sort(
    (a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The project before or after `currentProjectId` in `projects`, wrapping around,
 * or, without a current project in the list, the last or the first project.
 * Null with fewer than two projects, because there is nowhere else to go.
 */
export function adjacentProject(
  projects: readonly ProjectEntry[],
  currentProjectId: string | null,
  direction: 1 | -1,
): ProjectEntry | null {
  if (projects.length < 2) return null;
  const index = projects.findIndex((project) => project.id === currentProjectId);
  if (index === -1) return (direction === 1 ? projects[0] : projects.at(-1)) ?? null;
  return projects[(index + direction + projects.length) % projects.length] ?? null;
}

/**
 * The workspaces of a project, the most recently active first:
 * by the latest of the workspace's activity and its agents' activity, then by ID.
 * `agents` are the eligible agents.
 */
export function byRecentActivity(
  workspaces: readonly WorkspaceInfo[],
  agents: readonly AgentInfo[],
): WorkspaceInfo[] {
  const activity = new Map<string, number>();
  for (const workspace of workspaces) activity.set(workspace.id, workspace.activityAt);
  for (const agent of agents) {
    if (agent.workspaceId === null) continue;
    const current = activity.get(agent.workspaceId);
    if (current !== undefined) activity.set(agent.workspaceId, Math.max(current, agent.activityAt));
  }
  return [...workspaces].sort(
    (a, b) =>
      (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
