import { ACTIONS, type ActionId } from "../shared/actions";
import type { KeyLight, KeypadInfo, KeypadStatus } from "../shared/rpc";
import { NAVIGATION_KEY_ACTIONS, type TopKeyMode } from "../shared/settings";

/** One line that says whether the keypad works, and what to do when it does not. */
export function summarize(status: KeypadStatus | undefined): string {
  if (!status) return "Checking keypad…";
  const { bridge, keypad } = status;
  if (status.settings.status === "loading") return "Loading keypad settings…";
  if (status.settings.status === "error") return "Keypad actions off: settings error";
  if (bridge.state === "waiting") return "Open Paseo Micro to use your keypad";
  if (bridge.state !== "connected") return "Connecting to Paseo Micro…";
  if (!keypad?.connected) return "Keypad not connected";
  if (offInputLayer(keypad)) return `Switch your keypad to ${inputLayerList(keypad.inputLayers)}`;
  const needs = status.attentionCount;
  if (needs > 0) return `Keypad: ${needs} ${needs === 1 ? "agent needs" : "agents need"} you`;
  return "Keypad connected";
}

/** The summary, in the few words that fit in the sidebar's footer. */
export function sidebarLabel(status: KeypadStatus | undefined): string {
  if (status?.settings.status === "ready" && status.bridge.state === "waiting")
    return "Open Paseo Micro";
  return summarize(status);
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
