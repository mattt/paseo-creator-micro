import { ACTION_KEYS, actionKeyIndex, WORKSPACE_KEY_COUNT } from "../shared/keypad";
import type {
  ActionKeyLightSource,
  KeypadSettings,
  KeyState,
  LightStyle,
} from "../shared/settings";
import { actionState, type ActionState } from "./actionable";
import { isKeypadTarget, type AgentInfo } from "./agents";
import type { BridgeKeyLight, BridgeZoneLight } from "./bridge-protocol";
import type { Slots } from "./slots";
import { needsInput, workspaceState, type WorkspaceInfo } from "./workspaces";

export type LightSettings = KeypadSettings["lights"];

/** The light of an action key whose source is not "none", and what it shows. */
export interface ActionKeyLight {
  readonly key: number;
  readonly source: Exclude<ActionKeyLightSource, "none">;
  /** The state of the agent that the light shows, or null when it is off. */
  readonly state: ActionState | null;
}

export interface LightFrame {
  /**
   * One light for each workspace key, 0–5, then one for each action key with a light source,
   * in key order. Action keys whose source is "none" get no light, so they show `keysZone`.
   */
  readonly keys: readonly BridgeKeyLight[];
  /** The state that each workspace key shows. */
  readonly states: readonly KeyState[];
  /** The action keys with a light source, in key order. */
  readonly actionKeys: readonly ActionKeyLight[];
  readonly keysZone: BridgeZoneLight;
  /** The underglow. */
  readonly ambient: BridgeZoneLight;
  /** Whether any eligible agent that keypad actions may target, on a key or not, needs input. */
  readonly needsInput: boolean;
}

const OFF: BridgeZoneLight = { color: "#000000", effect: "off", brightness: 0, speed: 0 };

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function zone(style: LightStyle, brightness = style.brightness): BridgeZoneLight {
  if (style.effect === "off") return { ...OFF };
  return {
    color: style.color,
    effect: style.effect,
    brightness: round(Math.min(1, Math.max(0, brightness))),
    speed: style.speed,
  };
}

function isOff(style: LightStyle): boolean {
  return style.effect === "off" || style.brightness <= 0;
}

/**
 * The light of a workspace key in a state. The selected workspace's key is brighter,
 * and it shows the selected-off light when its state's light is off.
 */
export function keyLight(
  key: number,
  state: KeyState,
  selected: boolean,
  lights: LightSettings,
): BridgeKeyLight {
  const style = lights[state];
  if (selected && isOff(style)) return { key, ...zone(lights.selectedOff) };
  const brightness = selected ? style.brightness * lights.selectedBrightness : style.brightness;
  return { key, ...zone(style, brightness) };
}

/** The light of an agent's action state in the state colors, or off for no state. */
function stateLight(state: ActionState | null, lights: LightSettings): BridgeZoneLight {
  return state === null ? { ...OFF } : zone(lights[state]);
}

/**
 * The underglow, by its source: off; `underglowStyle` while any agent needs input;
 * or the state of the next agent that needs action (`next`), off when there is none.
 */
export function underglowLight(
  anyNeedsInput: boolean,
  next: ActionState | null,
  lights: LightSettings,
): BridgeZoneLight {
  switch (lights.underglowSource) {
    case "off":
      return { ...OFF };
    case "anyNeedsInput":
      return anyNeedsInput ? zone(lights.underglowStyle) : { ...OFF };
    case "nextActionableAgent":
      return stateLight(next, lights);
  }
}

/**
 * The action keys with a light source and their lights: "nextActionableAgent" shows
 * the state of the next agent that needs action (`next`), and is off when there is none.
 */
export function actionKeyLights(
  next: ActionState | null,
  lights: LightSettings,
): { keys: BridgeKeyLight[]; actionKeys: ActionKeyLight[] } {
  const keys: BridgeKeyLight[] = [];
  const actionKeys: ActionKeyLight[] = [];
  for (const input of ACTION_KEYS) {
    const source = lights.actionKeys[input];
    if (source === "none") continue;
    const key = actionKeyIndex(input);
    actionKeys.push({ key, source, state: next });
    keys.push({ key, ...stateLight(next, lights) });
  }
  return { keys, actionKeys };
}

/**
 * The thinking meter on the workspace keys: keys 0 to `lit` - 1 show the meter light,
 * and the others show the meter's unlit light.
 */
export function meterLights(lit: number, lights: LightSettings): BridgeKeyLight[] {
  return Array.from({ length: WORKSPACE_KEY_COUNT }, (_, key) => ({
    key,
    ...zone(key < lit ? lights.meter : lights.meterOff),
  }));
}

/** The failure flash: every workspace key shows the failure light. */
export function failureLights(lights: LightSettings): BridgeKeyLight[] {
  return Array.from({ length: WORKSPACE_KEY_COUNT }, (_, key) => ({
    key,
    ...zone(lights.failure),
  }));
}

/**
 * What the workspace keys show for a moment instead of their workspaces:
 * the thinking meter with `lit` keys lit, or the flash of a failed thinking change.
 */
export type KeyOverlay =
  | { readonly kind: "meter"; readonly lit: number }
  | { readonly kind: "failure" };

function overlayLights(overlay: KeyOverlay, lights: LightSettings): BridgeKeyLight[] {
  return overlay.kind === "meter" ? meterLights(overlay.lit, lights) : failureLights(lights);
}

/** What the lights need to know about a top key; see `TopKeyInfo` in `server/top-keys.ts`. */
export interface TopKeyLightInput {
  readonly kind: "workspace" | "agent" | "navigation" | "off";
  readonly state: KeyState;
  readonly selected: boolean;
  readonly enabled: boolean;
}

/**
 * The light of a top key: a workspace or an agent in its state's light (`keyLight`);
 * a navigation key in `lights.navigation` while it can act, else off; an "off" key off.
 */
export function topKeyLight(
  key: number,
  input: TopKeyLightInput,
  lights: LightSettings,
): BridgeKeyLight {
  switch (input.kind) {
    case "workspace":
    case "agent":
      return keyLight(key, input.state, input.selected, lights);
    case "navigation":
      return { key, ...(input.enabled ? zone(lights.navigation) : { ...OFF }) };
    case "off":
      return { key, ...OFF };
  }
}

export interface LightOptions {
  /** What the workspace keys show for a moment instead of their workspaces, if anything. */
  readonly overlay?: KeyOverlay | null;
  /** Whether subagents count as failed, needing input, or done; see `agentState`. */
  readonly includeSubagents?: boolean;
  /**
   * The agent that "open next agent that needs action" would open next, or null when none
   * qualifies; the lights with the "nextActionableAgent" source show its state.
   */
  readonly nextAgent?: AgentInfo | null;
  /**
   * The top keys as the top-key mode shows them, which replace the workspaces of `slots`;
   * without them, the top keys show the workspaces of `slots`.
   */
  readonly topKeys?: readonly TopKeyLightInput[] | null;
}

/**
 * Computes every light the plugin controls.
 * `agents` are the eligible agents, and `workspaceAgents` groups them by workspace.
 * While there is an overlay, the workspace keys show it instead of their workspaces;
 * the states stay those of the workspaces.
 * A subagent lights its workspace's key only while it runs, and never lights the underglow,
 * unless `includeSubagents` is on.
 * The action keys with a light source, and the underglow by default, show the state of `nextAgent`.
 */
export function computeLights(
  slots: Slots,
  workspaces: ReadonlyMap<string, WorkspaceInfo>,
  agents: readonly AgentInfo[],
  workspaceAgents: ReadonlyMap<string, readonly AgentInfo[]>,
  selectedWorkspaceId: string | null,
  lights: LightSettings,
  { overlay = null, includeSubagents = false, nextAgent = null, topKeys = null }: LightOptions = {},
): LightFrame {
  const states: KeyState[] = [];
  const keys: BridgeKeyLight[] = [];
  for (let key = 0; key < WORKSPACE_KEY_COUNT; key += 1) {
    const top = topKeys?.[key];
    if (top) {
      states.push(top.state);
      keys.push(topKeyLight(key, top, lights));
      continue;
    }
    const id = slots[key] ?? null;
    const workspace = id === null ? undefined : workspaces.get(id);
    const state: KeyState = workspace
      ? workspaceState(workspaceAgents.get(workspace.id) ?? [], includeSubagents)
      : "empty";
    states.push(state);
    keys.push(
      keyLight(key, state, workspace !== undefined && workspace.id === selectedWorkspaceId, lights),
    );
  }
  const anyNeedsInput = agents.some(
    (agent) => isKeypadTarget(agent, includeSubagents) && needsInput(agent),
  );
  const next = nextAgent === null ? null : actionState(nextAgent);
  const action = actionKeyLights(next, lights);
  return {
    keys: [...(overlay === null ? keys : overlayLights(overlay, lights)), ...action.keys],
    states,
    actionKeys: action.actionKeys,
    keysZone: zone(lights.keysZone),
    ambient: underglowLight(anyNeedsInput, next, lights),
    needsInput: anyNeedsInput,
  };
}
