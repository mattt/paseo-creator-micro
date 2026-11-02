import type { ActionId } from "../shared/actions";
import { RADIAL_SLOT_NAMES } from "../shared/radial-menu";
import type { RadialSlot } from "../shared/settings";
import {
  cycleSelection,
  navigationBlocker,
  nextStuckWorkspace,
  planTrigger,
  selectedTarget,
  targetAgents,
  workspaceTarget,
  type ActionEnvironment,
  type ActionPlan,
} from "./actions";
import { agentName, type AgentInfo } from "./agents";
import type { BridgeCommand } from "./bridge-protocol";
import { triggerFor } from "./input-map";
import { isRunning } from "./workspaces";

/**
 * The agent that the radial menu acts on: the selected workspace's agent
 * (the agent that a recent agent's key selected, else the most relevant agent),
 * or without a selected workspace the fallback of `targets.fallback`
 * (the agent that key 7 would open next, else the most recently active agent),
 * the same agent that the joystick's prompts and the other agent actions use,
 * without subagents unless the settings include them. Null without one.
 */
export function radialTarget(env: ActionEnvironment): AgentInfo | null {
  return selectedTarget(env)?.agent ?? null;
}

/** Actions that act on the target agent, so that a slot with one cannot act without a target. */
const AGENT_ACTIONS: ReadonlySet<ActionId> = new Set([
  "approvePermission",
  "denyPermission",
  "stopAgent",
  "thinkingUp",
  "thinkingDown",
  "sendPrompt",
  "openSelectedWorkspace",
]);

/**
 * Why a slot cannot act now, or null when it can. PaseoMicro dims a slot that cannot act.
 *
 * - An empty slot (`none`) never acts.
 * - A slot that acts on the agent needs a target; approve and deny need a pending request
 *   of the target, because the menu names the target and must not answer another agent's request;
 *   stop needs a target that is running; a prompt needs text.
 * - "Next agent that needs action", "next workspace that needs input",
 *   and the workspace selection need something to go to.
 * - Back and forward, previous and next project, and previous and next workspace
 *   need somewhere to go (`navigationBlocker`).
 * - Other actions, such as shortcuts and scrolling, can always act.
 */
export function slotBlocker(
  slot: RadialSlot,
  env: ActionEnvironment,
  target: AgentInfo | null = radialTarget(env),
): string | null {
  const { action } = slot;
  if (action === "none") return "the slot has no action";
  if (
    action === "openSelectedWorkspace" &&
    workspaceTarget(env, env.selectedWorkspaceId()) === null
  ) {
    // Opening selects a workspace, so the fallback agent does not stand in for it.
    return "no workspace is selected";
  }
  if (AGENT_ACTIONS.has(action) && target === null) return "no agent is selected";
  const navigation = navigationBlocker(action, env);
  if (navigation !== null) return navigation;
  switch (action) {
    case "approvePermission":
    case "denyPermission":
      return target && target.pendingPermissions.length > 0
        ? null
        : `${target ? agentName(target) : "the agent"} has no pending request`;
    case "stopAgent":
      return target && isRunning(target)
        ? null
        : `${target ? agentName(target) : "the agent"} is not running`;
    case "sendPrompt":
      return slot.text.trim() === "" ? "the slot has no prompt" : null;
    case "nextActionableAgent": {
      const next = env
        .actionableWalk()
        .peek(targetAgents(env), env.openedAgentId(), (agentId, requestId) =>
          env.permissionSeenAt(agentId, requestId),
        );
      return next ? null : "no agent needs action";
    }
    case "nextStuckWorkspace":
      return nextStuckWorkspace(env.workspaces(), targetAgents(env), env.selectedWorkspaceId())
        ? null
        : "no workspace needs input";
    case "selectNextWorkspace":
    case "selectPreviousWorkspace":
      return cycleSelection(env.slots(), env.selectedWorkspaceId(), 1) === null
        ? "no workspaces are on the keys"
        : null;
    default:
      return null;
  }
}

/**
 * The command that sets the radial menu in PaseoMicro, with each slot's enabled state
 * and the target's name, or the command that clears it when the menu is off.
 */
export function radialMenuCommand(env: ActionEnvironment): BridgeCommand {
  const settings = env.settings();
  if (!settings.radialMenu.enabled) return { type: "clearRadialMenu" };
  const target = radialTarget(env);
  return {
    type: "setRadialMenu",
    slots: settings.radialMenu.slots.map((slot) => ({
      icon: slot.icon,
      label: slot.label,
      ...(slot.color === null ? {} : { color: slot.color }),
      enabled: slotBlocker(slot, env, target) === null,
    })),
    target: target ? agentName(target) : null,
    bundleID: settings.connection.paseoBundleId,
  };
}

/**
 * Decides what a pick of a radial menu slot does, with the slots and agents as they are now.
 * A slot that can no longer act, because the target or its request changed
 * after PaseoMicro drew the menu, does nothing and says why.
 * Otherwise the slot's action runs as any input's would, through `planTrigger`:
 * its target is fixed now, and it is checked again just before it runs.
 */
export function planRadialSlot(index: number, env: ActionEnvironment): ActionPlan {
  const settings = env.settings();
  const slot = settings.radialMenu.slots[index];
  const name = RADIAL_SLOT_NAMES[index] ?? `slot ${index}`;
  if (!settings.radialMenu.enabled || !slot) {
    return {
      kind: "done",
      result: { action: "none", ok: false, message: "The radial menu is off" },
    };
  }
  const blocker = slotBlocker(slot, env);
  if (blocker !== null) {
    return {
      kind: "done",
      result: {
        action: slot.action,
        ok: false,
        message: `Skipped ${slot.label} (${name}): ${blocker}`,
      },
    };
  }
  return planTrigger(triggerFor({ action: slot.action, text: slot.text }, "step"), env);
}
