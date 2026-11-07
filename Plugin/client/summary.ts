import { ACTIONS, type ActionId } from "../shared/actions";
import type { ACTION_STATES, KeyLight, KeypadInfo, KeypadStatus } from "../shared/rpc";
import { NAVIGATION_KEY_ACTIONS, type TopKeyMode } from "../shared/settings";

/** One line that says whether the keypad works, and what to do when it does not. */
export function summarize(status: KeypadStatus | undefined): string {
  return problem(status) ?? "Keypad ready";
}

/** What keeps the keypad from working, in a few words, or null when it works. */
function problem(status: KeypadStatus | undefined): string | null {
  if (!status) return "Checking keypad…";
  const { bridge, keypad } = status;
  if (status.settings.status === "loading") return "Loading keypad settings…";
  if (status.settings.status === "error") return "Keypad actions off: settings error";
  if (bridge.state === "waiting") return "Open Paseo Micro to use your keypad";
  if (bridge.state !== "connected") return "Connecting to Paseo Micro…";
  if (!keypad?.connected) return "Keypad not connected";
  if (offInputLayer(keypad)) return `Switch your keypad to ${inputLayerList(keypad.inputLayers)}`;
  return null;
}

/** Whether the keypad works: Paseo Micro and the keypad are connected, on an input layer. */
export function keypadWorks(status: KeypadStatus | undefined): boolean {
  return problem(status) === null;
}

/**
 * The words of Paseo's own sidebar for the states of an agent that needs action:
 * a finished result that nobody has read is "Ready to review".
 */
export const ATTENTION_LABELS: Readonly<Record<(typeof ACTION_STATES)[number], string>> = {
  needsInput: "Needs input",
  failed: "Failed",
  done: "Ready to review",
};

/**
 * The few words that fit in the sidebar's footer: what keeps the keypad from working,
 * else the agent that key 7 opens next with its state, such as "Needs input: Fix login",
 * else "Keypad ready".
 */
export function sidebarLabel(status: KeypadStatus | undefined): string {
  if (status?.settings.status === "ready" && status.bridge.state === "waiting") {
    return "Open Paseo Micro";
  }
  const text = problem(status);
  if (text !== null) return text;
  const next = status?.nextAgent;
  return next ? `${ATTENTION_LABELS[next.state]}: ${next.name}` : "Keypad ready";
}

/**
 * What the picture and the sidebar show for a top key: its workspace's or agent's name,
 * its navigation action, or why it is empty. Without a status, the mode's own label.
 */
export function topKeyLabel(
  mode: TopKeyMode,
  key: number,
  info: KeypadStatus["keys"][number] | undefined,
): string {
  switch (mode) {
    case "navigation": {
      const action = info?.action ?? NAVIGATION_KEY_ACTIONS[key] ?? "none";
      return ACTIONS[action].label;
    }
    case "recentAgents":
      return info?.title ?? "No agent";
    case "workspaces":
    case "pinned":
      return info?.title ?? (mode === "pinned" ? "Not pinned" : "No workspace");
    case "off":
      return "Off";
  }
}

/**
 * Whether the keypad is on a layer whose inputs do not reach the app.
 * An app that does not report `lightsVisible` counts layer 4 alone.
 */
export function offInputLayer(keypad: KeypadInfo): boolean {
  if (keypad.layer === null) return false;
  return keypad.lightsVisible === null ? keypad.layer !== 4 : !keypad.lightsVisible;
}

/** The input layers for a sentence, such as "layer 4" or "layer 2 or 4". */
export function inputLayerList(layers: readonly number[] | null): string {
  const list = layers ?? [4];
  if (list.length === 0) return "a Paseo layer";
  if (list.length === 1) return `layer ${list[0]}`;
  return `layer ${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
}

/** A color for a light as it might look: dimmer lights mix with the background. */
export function lightSwatch(light: KeyLight | null | undefined, fallback: string): string {
  if (!light || light.effect === "off" || light.brightness <= 0) return fallback;
  const alpha = Math.round((0.35 + 0.65 * Math.min(1, light.brightness)) * 255);
  return `${light.color}${alpha.toString(16).padStart(2, "0")}`;
}

/** What the picture shows for a joystick direction: its prompt, "No prompt", or its action. */
export function joystickDetail(action: ActionId, text: string): string {
  if (action !== "sendPrompt") return action === "none" ? "—" : ACTIONS[action].label;
  const prompt = text.trim().replace(/\s+/g, " ");
  return prompt === "" ? "No prompt" : `"${prompt}"`;
}

/**
 * How the keypad connects and its charge, as the menu bar app's header shows them,
 * such as "Connected via USB · 64% battery"; null while the keypad is not connected.
 */
export function connectionDetail(status: KeypadStatus | undefined): string | null {
  const keypad = status?.keypad;
  if (status?.bridge.state !== "connected" || !keypad?.connected) return null;
  const parts = [keypad.transport ? `Connected via ${keypad.transport}` : "Connected"];
  if (keypad.battery !== null) {
    parts.push(`${Math.round(keypad.battery)}% battery${keypad.charging ? ", charging" : ""}`);
  }
  return parts.join(" · ");
}

/** Short names for actions, to fit on a keycap in the picture. */
const KEYCAP_LABELS: Partial<Record<ActionId, string>> = {
  none: "",
  nextActionableAgent: "Next agent",
  nextStuckWorkspace: "Next waiting workspace",
  navigateBack: "Back",
  navigateForward: "Forward",
  previousWorkspace: "Previous workspace",
  nextWorkspace: "Next workspace",
  newAgent: "New agent",
  focusComposer: "Composer",
  jumpToBottom: "Jump to bottom",
  toggleVoiceMode: "Voice mode",
  approvePermission: "Approve",
  denyPermission: "Deny",
  stopAgent: "Stop",
  selectNextWorkspace: "Select next",
  selectPreviousWorkspace: "Select previous",
  openSelectedWorkspace: "Open selected",
  sendPrompt: "Prompt",
};

/** An action's name on a keycap: a short form of its label. */
export function keycapLabel(action: ActionId): string {
  return KEYCAP_LABELS[action] ?? ACTIONS[action].label;
}
