import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  ACTION_IDS,
  RENAMED_ACTIONS,
  VERSION_4_RENAMED_ACTIONS,
  VERSION_9_RENAMED_ACTIONS,
  type ActionId,
} from "./actions";
import { groupsAreDisjoint, type KeyGroups } from "./key-groups";
import {
  ACTION_INPUTS,
  ACTION_KEYS,
  WORKSPACE_KEY_COUNT,
  type ActionInput,
  type ActionKey,
} from "./keypad";
import {
  DEFAULT_RADIAL_SLOTS,
  RADIAL_LABEL_MAX_LENGTH,
  RADIAL_MENU_ICONS,
  RADIAL_SLOT_COUNT,
  VERSION_13_RADIAL_SLOTS,
  type RadialSlotDefault,
} from "./radial-menu";

/** Lighting effects, by the names the bridge accepts. */
export const LIGHT_EFFECTS = [
  "off",
  "solid",
  "snake",
  "rainbow",
  "breathing",
  "gradient",
  "shallowBreathing",
] as const;

export type LightEffect = (typeof LIGHT_EFFECTS)[number];

/**
 * Workspace key states, from most to least urgent, then the key without a workspace.
 * A workspace shows the most urgent state of its agents; see `server/workspaces.ts`.
 */
export const KEY_STATES = ["failed", "needsInput", "running", "done", "idle", "empty"] as const;

export type KeyState = (typeof KEY_STATES)[number];

export const KEY_STATE_LABELS: Readonly<Record<KeyState, string>> = {
  failed: "Failed",
  needsInput: "Needs input",
  running: "Running",
  done: "Done, unread",
  idle: "Idle, read, or no agents",
  empty: "No workspace",
};

/**
 * What an action key's own light shows. "none" sends the key no light of its own,
 * so it shows the key backlight (`keysZone`); "nextActionableAgent" shows the state
 * of the agent that "open next agent that needs action" would open next, and is off
 * when no agent needs action.
 * A key shows its own light only on a keypad layer that binds it to an `AG` code
 * (`KV_OAI_AG06`–`KV_OAI_AG12`); see the repository README's keypad layers section.
 */
export const ACTION_KEY_LIGHT_SOURCES = ["none", "nextActionableAgent"] as const;

export type ActionKeyLightSource = (typeof ACTION_KEY_LIGHT_SOURCES)[number];

/**
 * What the underglow (the ambient zone) shows: nothing, `underglowStyle` while any agent
 * needs input, or the state of the agent that "open next agent that needs action"
 * would open next, off when no agent needs action.
 */
export const UNDERGLOW_SOURCES = ["off", "anyNeedsInput", "nextActionableAgent"] as const;

export type UnderglowSource = (typeof UNDERGLOW_SOURCES)[number];

export const LIGHT_SOURCE_LABELS: Readonly<Record<ActionKeyLightSource | UnderglowSource, string>> =
  {
    none: "Key backlight",
    off: "Off",
    anyNeedsInput: "While any agent needs input",
    nextActionableAgent: "Next agent that needs action",
  };

/**
 * Key 6 (`ACT06`) opens the next agent that needs action by default.
 * Its light shows that agent's state, or stays off when no agent needs action.
 */
export const DEFAULT_ACTION_KEY_LIGHTS: Readonly<Record<ActionKey, ActionKeyLightSource>> = {
  ACT06: "nextActionableAgent",
  ACT07: "none",
  ACT08: "none",
  ACT09: "none",
  ACT10: "none",
  ACT11: "none",
  ACT12: "none",
};

/**
 * The agent that the radial menu, the joystick's prompts, and the other actions on
 * "the selected workspace's agent" act on while no workspace is selected:
 * "nextActionable", the agent that "open next agent that needs action" would open next,
 * else the most recently active agent; or "none", no agent.
 * Neither selects a workspace.
 */
export const TARGET_FALLBACKS = ["nextActionable", "none"] as const;

export type TargetFallback = (typeof TARGET_FALLBACKS)[number];

export const TARGET_FALLBACK_LABELS: Readonly<Record<TargetFallback, string>> = {
  nextActionable: "Next agent that needs action, else the latest",
  none: "No agent",
};

/**
 * What the six top keys (keys 0–5, `AG00`–`AG05`) show and do, like the ChatGPT app's
 * "Agent keys" option for the Creator Micro 2:
 *
 * - "navigation": back, forward, previous project, previous workspace, next workspace,
 *   and next project (`NAVIGATION_KEY_ACTIONS`), dim white while the key can act.
 * - "recentAgents": the six most recently active agents, in the state colors.
 * - "workspaces": the six most recently active workspaces, in the state colors.
 * - "pinned": only the workspaces pinned to keys; the other keys are dark and do nothing.
 * - "off": every top key is dark and does nothing.
 */
export const TOP_KEY_MODES = ["navigation", "recentAgents", "workspaces", "pinned", "off"] as const;

export type TopKeyMode = (typeof TOP_KEY_MODES)[number];

export const TOP_KEY_MODE_LABELS: Readonly<Record<TopKeyMode, string>> = {
  navigation: "Navigation",
  recentAgents: "Recent agents",
  workspaces: "Workspaces",
  pinned: "Pinned workspaces",
  off: "Off",
};

/** The actions of the top keys in the "navigation" mode, from key 0 to key 5. */
export const NAVIGATION_KEY_ACTIONS = [
  "navigateBack",
  "navigateForward",
  "previousProject",
  "previousWorkspace",
  "nextWorkspace",
  "nextProject",
] as const satisfies readonly ActionId[];

export type NavigationAction = (typeof NAVIGATION_KEY_ACTIONS)[number];

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const ColorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOR, "Enter a color as #RRGGBB")
  .transform((value) => value.toUpperCase());

const unit = z.number().min(0).max(1);

export const LightStyleSchema = z.object({
  color: ColorSchema,
  effect: z.enum(LIGHT_EFFECTS),
  brightness: unit,
  speed: unit.default(0.5),
});

export type LightStyle = z.output<typeof LightStyleSchema>;

/**
 * Red, yellow, blue, and green. Running is blue, not amber,
 * because amber is hard to tell from the yellow of "needs input".
 */
const DEFAULT_STATE_STYLES: Readonly<Record<KeyState, z.input<typeof LightStyleSchema>>> = {
  failed: { color: "#FF2D2D", effect: "solid", brightness: 0.5 },
  needsInput: { color: "#FFD000", effect: "breathing", brightness: 0.6, speed: 0.6 },
  running: { color: "#2D7BFF", effect: "solid", brightness: 0.5 },
  done: { color: "#2DFF6A", effect: "solid", brightness: 0.3 },
  idle: { color: "#000000", effect: "off", brightness: 0 },
  empty: { color: "#000000", effect: "off", brightness: 0 },
};

/** The thinking meter's lit keys: violet, so that it is not read as a workspace state. */
const DEFAULT_METER_STYLE: z.input<typeof LightStyleSchema> = {
  color: "#A05CFF",
  effect: "solid",
  brightness: 0.6,
};

/** The flash of a failed thinking change: the red of a failed workspace, brighter. */
const DEFAULT_FAILURE_STYLE: z.input<typeof LightStyleSchema> = {
  color: "#FF2D2D",
  effect: "solid",
  brightness: 0.8,
};

const DEFAULT_UNDERGLOW_STYLE: z.input<typeof LightStyleSchema> = {
  color: "#FFD000",
  effect: "breathing",
  brightness: 0.4,
  speed: 0.5,
};

export const BindingSchema = z.object({
  action: z.enum(ACTION_IDS),
  /** The text for `sendPrompt`. Other actions ignore it. */
  text: z.string().max(4000).default(""),
});

export type Binding = z.output<typeof BindingSchema>;

/**
 * One slot of the joystick's radial menu: what it shows (an icon from a curated list,
 * a label of one or two words, and an optional color) and what it does (an action,
 * with a prompt for `sendPrompt`).
 */
export const RadialSlotSchema = z.object({
  icon: z.enum(RADIAL_MENU_ICONS),
  label: z
    .string()
    .trim()
    .min(1, "Enter a label")
    .max(RADIAL_LABEL_MAX_LENGTH, `Use at most ${RADIAL_LABEL_MAX_LENGTH} characters`),
  /** The slot's color as #RRGGBB, or null for the menu's default color. */
  color: ColorSchema.nullable().default(null),
  action: z.enum(ACTION_IDS),
  /** The text for `sendPrompt`. Other actions ignore it. */
  text: z.string().max(4000).default(""),
});

export type RadialSlot = z.output<typeof RadialSlotSchema>;

type DefaultBindings = Readonly<Record<ActionInput, { action: ActionId; text?: string }>>;

/**
 * The default action of every configurable input.
 * The third row opens the next agent that needs action, approves, denies, and starts a new agent.
 * Paseo exposes no fork to plugins or the CLI, so the fourth key sends Cmd+O (`agent.new`).
 * Keys 11 and 12 share one push-to-talk keycap, and key 13 submits.
 * No input toggles voice mode by default.
 * The dial scrolls the open conversation: a plain turn by a few lines, a held turn faster,
 * and a click to the bottom. Upward bursts caused Paseo's conversation list to crash.
 * Nothing on the dial interrupts an agent or changes its thinking level by default.
 * With the radial menu off, each joystick direction sends a prompt, empty until the user sets it.
 */
export const DEFAULT_BINDINGS: DefaultBindings = {
  ACT06: { action: "nextActionableAgent" },
  ACT07: { action: "approvePermission" },
  ACT08: { action: "denyPermission" },
  ACT09: { action: "newAgent" },
  ACT10: { action: "pushToTalk" },
  ACT11: { action: "pushToTalk" },
  ACT12: { action: "submit" },
  dialClockwise: { action: "scrollDown" },
  dialCounterclockwise: { action: "scrollUp" },
  dialPress: { action: "jumpToBottom" },
  dialHeldClockwise: { action: "scrollDownFast" },
  dialHeldCounterclockwise: { action: "scrollUpFast" },
  joystickUp: { action: "sendPrompt", text: "" },
  joystickDown: { action: "sendPrompt", text: "" },
  joystickLeft: { action: "sendPrompt", text: "" },
  joystickRight: { action: "sendPrompt", text: "" },
};

/**
 * Default actions of an earlier settings version, by action name, so that they need not be
 * current action IDs. An input that the version did not have is missing.
 */
type EarlierBindings = Readonly<Partial<Record<ActionInput, string>>>;

/**
 * The default actions of settings versions 9 to 13, which version 14 replaces where they were kept:
 * the third row went back and moved between workspaces.
 */
export const VERSION_13_BINDINGS: EarlierBindings = {
  ACT06: "nextActionableAgent",
  ACT07: "navigateBack",
  ACT08: "previousWorkspace",
  ACT09: "nextWorkspace",
  ACT10: "pushToTalk",
  ACT11: "pushToTalk",
  ACT12: "submit",
  dialClockwise: "scrollDown",
  dialCounterclockwise: "scrollUp",
  dialPress: "jumpToBottom",
  dialHeldClockwise: "scrollDownFast",
  dialHeldCounterclockwise: "scrollUpFast",
  joystickUp: "sendPrompt",
  joystickDown: "sendPrompt",
  joystickLeft: "sendPrompt",
  joystickRight: "sendPrompt",
};

/**
 * The default actions of settings versions 5 and 6, which version 7 replaces where they were kept:
 * the held dial changed thinking, and the click focused the composer.
 */
export const VERSION_6_BINDINGS: EarlierBindings = {
  ACT06: "nextActionableAgent",
  ACT07: "navigateBack",
  ACT08: "previousWorkspace",
  ACT09: "nextWorkspace",
  ACT10: "pushToTalk",
  ACT11: "pushToTalk",
  ACT12: "submit",
  dialClockwise: "scrollDown",
  dialCounterclockwise: "scrollUp",
  dialPress: "focusComposer",
  dialHeldClockwise: "thinkingUp",
  dialHeldCounterclockwise: "thinkingDown",
  joystickUp: "sendPrompt",
  joystickDown: "sendPrompt",
  joystickLeft: "sendPrompt",
  joystickRight: "sendPrompt",
};

/** The default actions of settings version 4, which version 5 replaces where they were kept. */
export const VERSION_4_BINDINGS: EarlierBindings = {
  ACT06: "nextActionableAgent",
  ACT07: "navigateBack",
  ACT08: "previousWorkspace",
  ACT09: "nextWorkspace",
  ACT10: "pushToTalk",
  ACT11: "pushToTalk",
  ACT12: "submit",
  dialClockwise: "selectNextWorkspace",
  dialCounterclockwise: "selectPreviousWorkspace",
  dialPress: "openSelectedWorkspace",
  joystickUp: "thinkingUp",
  joystickDown: "thinkingDown",
  joystickLeft: "selectPreviousWorkspace",
  joystickRight: "selectNextWorkspace",
};

/** The default actions of settings version 3, which version 4 replaced where they were kept. */
export const VERSION_3_BINDINGS: EarlierBindings = {
  ...VERSION_4_BINDINGS,
  ACT06: "nextStuckWorkspace",
  ACT12: "toggleVoiceMode",
};

/** The default actions of settings version 2, which version 3 replaced where they were kept. */
export const VERSION_2_BINDINGS: EarlierBindings = {
  ...VERSION_3_BINDINGS,
  ACT06: "openNextUnread",
  ACT07: "approvePermission",
  ACT08: "denyPermission",
  ACT09: "stopAgent",
  ACT10: "pushToTalk",
  ACT11: "toggleVoiceMode",
  ACT12: "none",
};

function bindingsSchema() {
  const shape = Object.fromEntries(
    ACTION_INPUTS.map((input) => [input, BindingSchema.prefault(DEFAULT_BINDINGS[input])]),
  ) as { [Input in ActionInput]: z.ZodPrefault<typeof BindingSchema> };
  return z.object(shape);
}

function actionKeyLightsSchema() {
  const shape = Object.fromEntries(
    ACTION_KEYS.map((key) => [
      key,
      z.enum(ACTION_KEY_LIGHT_SOURCES).default(DEFAULT_ACTION_KEY_LIGHTS[key]),
    ]),
  ) as { [Key in ActionKey]: z.ZodDefault<z.ZodEnum<{ [S in ActionKeyLightSource]: S }>> };
  return z.object(shape);
}

function lightsSchema() {
  const states = Object.fromEntries(
    KEY_STATES.map((state) => [state, LightStyleSchema.prefault(DEFAULT_STATE_STYLES[state])]),
  ) as { [State in KeyState]: z.ZodPrefault<typeof LightStyleSchema> };
  return z.object({
    ...states,
    /** Multiplies the brightness of the selected workspace's key, up to full brightness. */
    selectedBrightness: z.number().min(1).max(5).default(2),
    /** The selected workspace's key when its state's light is off, such as an idle workspace. */
    selectedOff: LightStyleSchema.prefault({ color: "#FFFFFF", effect: "solid", brightness: 0.15 }),
    /**
     * A top key in the navigation mode while it can act, such as back with an earlier place;
     * a key that cannot act is off. Dim white by default.
     */
    navigation: LightStyleSchema.prefault({ color: "#FFFFFF", effect: "solid", brightness: 0.15 }),
    /**
     * What the underglow (the ambient zone) shows.
     * By default, it shows the next agent that needs action, as key 6 does.
     */
    underglowSource: z.enum(UNDERGLOW_SOURCES).default("nextActionableAgent"),
    /** The underglow's light while any agent needs input, with the `anyNeedsInput` source. */
    underglowStyle: LightStyleSchema.prefault(DEFAULT_UNDERGLOW_STYLE),
    /**
     * What each action key's own light shows, in the state colors.
     * By default key 6 shows the next agent that needs action, and the others the key backlight.
     */
    actionKeys: actionKeyLightsSchema().prefault({}),
    /** The `keys` zone, which lights the keys that do not show workspaces. */
    keysZone: LightStyleSchema.prefault({ color: "#FFFFFF", effect: "solid", brightness: 0.1 }),
    /**
     * The lit keys of the thinking meter, which the workspace keys show for a moment
     * after a thinking change: one key for each step of the agent's level.
     */
    meter: LightStyleSchema.prefault(DEFAULT_METER_STYLE),
    /** The meter's unlit keys. */
    meterOff: LightStyleSchema.prefault({ color: "#000000", effect: "off", brightness: 0 }),
    /** The workspace keys' flash for about 0.6 seconds when a thinking change fails. */
    failure: LightStyleSchema.prefault(DEFAULT_FAILURE_STYLE),
  });
}

/**
 * Keys under one keycap. Each group acts as one key with its first key's binding:
 * its gesture starts with the first press of any of its keys and ends
 * when the last of them is released.
 * By default, keys 11 and 12 (`ACT10`, `ACT11`) share a double-wide keycap.
 */
export const DEFAULT_KEY_GROUPS: KeyGroups = [["ACT10", "ACT11"]];

export const KeyGroupsSchema = z
  .array(z.array(z.enum(ACTION_KEYS)).min(2).max(ACTION_KEYS.length))
  .max(ACTION_KEYS.length)
  .refine(groupsAreDisjoint, "A key can be under only one keycap");

/**
 * The longest time between two presses of a top key in the "recentAgents" mode
 * that counts as a double tap, which opens the key's agent.
 */
export const DOUBLE_TAP_MS = 400;

export const SettingsSchema = z.object({
  topKeys: z
    .object({
      /**
       * What the six top keys show and do (see `TOP_KEY_MODES`).
       * Navigation by default, as on the ChatGPT app.
       */
      mode: z.enum(TOP_KEY_MODES).default("navigation"),
      /**
       * In the "recentAgents" mode, whether a single tap opens the key's agent.
       * Off by default, as in the ChatGPT app: a single tap selects the agent
       * and its workspace, and a double tap opens it and brings Paseo to the front.
       */
      openOnSingleTap: z.boolean().default(false),
    })
    .prefault({}),
  bindings: bindingsSchema().prefault({}),
  radialMenu: z
    .object({
      /**
       * Whether the joystick opens the radial menu. On by default.
       * While it is on, the joystick's direction bindings do not fire;
       * they stay stored for when it is off.
       */
      enabled: z.boolean().default(true),
      /** The eight slots, clockwise from up. */
      slots: z
        .array(RadialSlotSchema)
        .length(RADIAL_SLOT_COUNT)
        .default(() => DEFAULT_RADIAL_SLOTS.map((slot) => ({ ...slot }))),
    })
    .prefault({}),
  keyGroups: KeyGroupsSchema.default(() => DEFAULT_KEY_GROUPS.map((group) => [...group])),
  /** Workspace IDs pinned to keys 0–5; null leaves the key to automatic assignment. */
  pins: z
    .array(z.string().min(1).nullable())
    .length(WORKSPACE_KEY_COUNT)
    .default(() => Array.from({ length: WORKSPACE_KEY_COUNT }, () => null)),
  lights: lightsSchema().prefault({}),
  agents: z
    .object({
      /**
       * Whether the keypad treats subagents, which other agents started, like other agents.
       * Off by default: key 7 and a workspace's actions never target a subagent,
       * and a subagent lights its workspace's key only while it runs,
       * because the agent that started it controls it.
       */
      includeSubagents: z.boolean().default(false),
    })
    .prefault({}),
  targets: z
    .object({
      /**
       * The agent that actions on the selected workspace's agent act on while no workspace
       * is selected, as after a plugin reload that could not restore the selection.
       * By default, the agent that key 7 would open next, else the most recently active agent,
       * so that the radial menu is never empty while an agent exists.
       */
      fallback: z.enum(TARGET_FALLBACKS).default("nextActionable"),
    })
    .prefault({}),
  pushToTalk: z
    .object({
      /** Sends Return after the release's Cmd+D, to send the dictated text. */
      sendReturnOnRelease: z.boolean().default(false),
      /**
       * Time between the Cmd+D that stops dictation and Return, for the transcription to land:
       * on release when `sendReturnOnRelease` is on, and when submit stops dictation.
       */
      returnDelayMs: z.number().int().min(0).max(5000).default(600),
    })
    .prefault({}),
  scroll: z
    .object({
      /** Lines that one dial step, or one press of a scroll key, scrolls. */
      lines: z.number().int().min(1).max(20).default(3),
      /** Lines that one step of a fast scroll, such as a turn of the held dial, scrolls. */
      fastLines: z.number().int().min(1).max(100).default(15),
      /** Where in Paseo's window the scroll happens, as a fraction of its height from the top. */
      fromTop: z.number().min(0.1).max(0.9).default(0.4),
    })
    .prefault({}),
  connection: z
    .object({
      /** The bridge socket of the keypad app; empty for the default location. */
      socketPath: z.string().trim().default(""),
      /** The `paseo` CLI; empty to search PATH, then the Paseo app bundle. */
      cliPath: z.string().trim().default(""),
      /** The bundle ID that receives shortcuts such as Cmd+D. */
      paseoBundleId: z.string().trim().min(1).default("sh.paseo.desktop"),
    })
    .prefault({}),
});

export type KeypadSettings = z.output<typeof SettingsSchema>;

export const SETTINGS_ID = "keypad";

/**
 * Version 1 put agents on the keys; version 2 put workspaces on them;
 * version 3 has the workspace navigation keys and the shared push-to-talk keycap;
 * version 4 has the next-agent-that-needs-action key and the submit key;
 * version 5 has the scrolling dial, thinking on the held dial, and joystick prompts;
 * version 6 leaves subagents out of the keypad's targets and attention by default;
 * version 7 scrolls fast on the held dial and jumps to an edge on the click;
 * version 8 lights key 6 and the underglow with the next agent that needs action;
 * version 9 makes the dial click jump only to the bottom;
 * version 10 adds the joystick's radial menu;
 * version 11 drops the period from the radial menu's default "Continue" prompt;
 * version 12 drops the final period from the rest of its default prompts;
 * version 13 adds the target without a selected workspace (`targets.fallback`);
 * version 14 follows the ChatGPT app's layout: the top keys' mode (navigation by default),
 * approve, deny, and a new agent on the third row, and back and forward in the radial menu.
 */
export const SETTINGS_VERSION = 14;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts the stored settings of the agent-key version (1) to version 2.
 * See `migrateSettings`.
 *
 * - Pins named agents, so they are dropped; every key returns to automatic assignment.
 * - Bindings to "select next agent", "select previous agent", and "open selected agent"
 *   become the workspace actions. Other bindings are kept as they are.
 * - The old state colors (permission, error, unread, running, idle, empty) are dropped,
 *   because the states changed meaning, so the new defaults apply.
 *   The selected-key brightness and the other keys' light are kept.
 * - The ambient switch and brightness become the version 2 underglow switch and brightness,
 *   which version 8 turns into the underglow's source.
 * - Push to talk and the connection are kept.
 */
function migrateFromVersion1(values: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = {};
  if (isRecord(values.bindings)) {
    const bindings: Record<string, unknown> = {};
    for (const [input, binding] of Object.entries(values.bindings)) {
      if (isRecord(binding) && typeof binding.action === "string") {
        bindings[input] = { ...binding, action: RENAMED_ACTIONS[binding.action] ?? binding.action };
      } else {
        bindings[input] = binding;
      }
    }
    migrated.bindings = bindings;
  }
  if (isRecord(values.lights)) {
    const old = values.lights;
    const lights: Record<string, unknown> = {};
    if (old.selectedBrightness !== undefined) lights.selectedBrightness = old.selectedBrightness;
    if (old.keysZone !== undefined) lights.keysZone = old.keysZone;
    if (old.ambient !== undefined) lights.underglow = old.ambient;
    if (old.ambientBrightness !== undefined) {
      lights.underglowStyle = { ...DEFAULT_UNDERGLOW_STYLE, brightness: old.ambientBrightness };
    }
    migrated.lights = lights;
  }
  if (values.pushToTalk !== undefined) migrated.pushToTalk = values.pushToTalk;
  if (values.connection !== undefined) migrated.connection = values.connection;
  return migrated;
}

/**
 * Moves each stored binding that still runs its default action of an earlier version
 * to the next version's default; a binding that the user changed keeps its action,
 * except that an action in `renamed` takes its new name.
 * A binding that moves to "send prompt" starts with an empty prompt, so that text left
 * from an earlier choice is never sent; for other actions, which ignore the text,
 * the text is kept as it is.
 */
function moveKeptDefaults(
  values: Record<string, unknown>,
  previous: EarlierBindings,
  next: EarlierBindings,
  renamed: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  if (!isRecord(values.bindings)) return values;
  const bindings: Record<string, unknown> = { ...values.bindings };
  for (const [input, stored] of Object.entries(bindings)) {
    if (!isRecord(stored) || typeof stored.action !== "string") continue;
    const kept = isActionInput(input) && stored.action === previous[input];
    const action =
      (kept ? next[input as ActionInput] : undefined) ?? renamed[stored.action] ?? stored.action;
    if (action === stored.action) continue;
    bindings[input] =
      action === "sendPrompt" ? { ...stored, action, text: "" } : { ...stored, action };
  }
  return { ...values, bindings };
}

function isActionInput(input: string): input is ActionInput {
  return (ACTION_INPUTS as readonly string[]).includes(input);
}

/**
 * Converts version 2 to version 3. Each binding that still runs its version 2 default
 * takes the version 3 default; a binding that the user changed stays as it is.
 * Everything else is kept, and the new settings (the shared keycap of keys 11 and 12
 * and the selected-off light) take their defaults.
 */
function migrateFromVersion2(values: Record<string, unknown>): Record<string, unknown> {
  return moveKeptDefaults(values, VERSION_2_BINDINGS, VERSION_3_BINDINGS);
}

/**
 * Converts version 3 to version 4. Each binding that still runs its version 3 default
 * takes the version 4 default: key 7 (`ACT06`) opens the next agent that needs action,
 * and key 13 (`ACT12`) submits, so no input toggles voice mode by default.
 * A binding that the user changed stays, except that "open next unread agent",
 * which version 4 folds into "open next agent that needs action", takes the new action.
 */
function migrateFromVersion3(values: Record<string, unknown>): Record<string, unknown> {
  return moveKeptDefaults(
    values,
    VERSION_3_BINDINGS,
    VERSION_4_BINDINGS,
    VERSION_4_RENAMED_ACTIONS,
  );
}

/**
 * Converts version 4 to version 5. Each binding that still runs its version 4 default
 * takes the version 5 default: the dial's turns scroll, its press focuses the composer,
 * and each joystick direction sends a prompt, empty until the user sets it.
 * A binding that the user changed stays. The held dial's turns, which version 4 did not have,
 * the scroll settings, and the thinking meter's lights take their defaults.
 */
function migrateFromVersion4(values: Record<string, unknown>): Record<string, unknown> {
  return moveKeptDefaults(values, VERSION_4_BINDINGS, VERSION_6_BINDINGS);
}

/**
 * Converts version 6 to version 7. Each dial binding that still runs its version 6 default
 * takes the version 7 default: the held dial scrolls fast instead of changing thinking,
 * and the click jumps instead of focusing the composer. The jump takes its current name,
 * which version 9 gave it, at once.
 * A binding that the user changed stays, and the thinking and composer actions stay assignable.
 * The fast scroll's lines take their default.
 */
function migrateFromVersion6(values: Record<string, unknown>): Record<string, unknown> {
  return moveKeptDefaults(values, VERSION_6_BINDINGS, VERSION_13_BINDINGS);
}

/**
 * Converts version 7 to version 8. The underglow switch becomes the underglow's source:
 * on, its default, takes the new default, the next agent that needs action,
 * and off stays off. The underglow's style is kept for the "while any agent needs input" source.
 * The action keys' light sources take their defaults: key 6 shows the next agent that needs action.
 */
function migrateFromVersion7(values: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(values.lights)) return values;
  const { underglow, ...lights } = values.lights;
  if (underglow === false) lights.underglowSource = "off";
  return { ...values, lights };
}

/**
 * Converts version 8 to version 9. A binding of "jump to the bottom, then the top" (`jumpToEdge`),
 * the click's default or the user's choice, becomes "jump to the bottom" (`jumpToBottom`).
 * Everything else is kept.
 */
function migrateFromVersion8(values: Record<string, unknown>): Record<string, unknown> {
  return moveKeptDefaults(values, {}, {}, VERSION_9_RENAMED_ACTIONS);
}

/**
 * Converts version 9 to version 10, which adds the joystick's radial menu.
 * The menu takes its defaults: it is on, with the default slots.
 * The joystick's direction bindings, including any prompts, stay as they are,
 * so that they work again when the menu is turned off.
 */
function migrateFromVersion9(values: Record<string, unknown>): Record<string, unknown> {
  return values;
}

/**
 * Converts version 10 to version 11: a radial slot that still has the version-10 default prompt
 * "Continue." gets the new default, "Continue"; changed slots stay.
 */
function migrateFromVersion10(values: Record<string, unknown>): Record<string, unknown> {
  const radialMenu = values.radialMenu;
  if (!isRecord(radialMenu) || !Array.isArray(radialMenu.slots)) return values;
  const slots = radialMenu.slots.map((slot: unknown) =>
    isRecord(slot) &&
    slot.icon === "play.circle" &&
    slot.label === "Continue" &&
    slot.action === "sendPrompt" &&
    slot.text === "Continue."
      ? { ...slot, text: "Continue" }
      : slot,
  );
  return { ...values, radialMenu: { ...radialMenu, slots } };
}

/** The radial menu's version-11 default prompts that end with a period, by slot label. */
const VERSION_11_RADIAL_PROMPTS: Readonly<Record<string, string>> = {
  Test: "Run the tests and fix any failures.",
  Commit: "Commit this work.",
  Review: "Review your diff for bugs.",
  Summary: "Summarize where things stand and what's left.",
};

/**
 * Converts version 11 to version 12: a radial slot whose prompt is still its version-11 default
 * loses the final period; changed prompts stay.
 */
function migrateFromVersion11(values: Record<string, unknown>): Record<string, unknown> {
  const radialMenu = values.radialMenu;
  if (!isRecord(radialMenu) || !Array.isArray(radialMenu.slots)) return values;
  const slots = radialMenu.slots.map((slot: unknown) => {
    if (!isRecord(slot) || slot.action !== "sendPrompt" || typeof slot.label !== "string")
      return slot;
    const old = VERSION_11_RADIAL_PROMPTS[slot.label];
    return old !== undefined && slot.text === old ? { ...slot, text: old.slice(0, -1) } : slot;
  });
  return { ...values, radialMenu: { ...radialMenu, slots } };
}

/**
 * Converts version 12 to version 13, which adds `targets.fallback`.
 * Nothing changes; the new setting takes its default, the next agent that needs action.
 */
function migrateFromVersion12(values: Record<string, unknown>): Record<string, unknown> {
  return values;
}

/** Whether a stored radial slot is still a default slot, with the stored defaults filled in. */
function isSlot(stored: unknown, slot: RadialSlotDefault): boolean {
  if (!isRecord(stored)) return false;
  const color = typeof stored.color === "string" ? stored.color.toUpperCase() : stored.color;
  return (
    stored.icon === slot.icon &&
    stored.label === slot.label &&
    (color ?? null) === slot.color &&
    stored.action === slot.action &&
    (stored.text ?? "") === slot.text
  );
}

/**
 * Converts version 13 to version 14, which follows the ChatGPT app's layout:
 *
 * - The top keys' mode becomes "navigation", also for existing settings.
 * - Each binding that still runs its version 13 default takes the version 14 default:
 *   key 7 (`ACT07`) approves, key 8 (`ACT08`) denies, and key 9 (`ACT09`) starts a new agent.
 * - A radial slot that is still its version 13 default Approve (up) or Deny (down)
 *   becomes Back or Forward.
 *
 * Bindings and slots that the user changed stay as they are.
 */
function migrateFromVersion13(values: Record<string, unknown>): Record<string, unknown> {
  const current = Object.fromEntries(
    ACTION_INPUTS.map((input) => [input, DEFAULT_BINDINGS[input].action]),
  ) as EarlierBindings;
  const migrated = moveKeptDefaults(values, VERSION_13_BINDINGS, current);
  const topKeys = isRecord(migrated.topKeys) ? migrated.topKeys : {};
  const result: Record<string, unknown> = {
    ...migrated,
    topKeys: { ...topKeys, mode: "navigation" },
  };
  const radialMenu = migrated.radialMenu;
  if (isRecord(radialMenu) && Array.isArray(radialMenu.slots)) {
    const slots = radialMenu.slots.map((slot: unknown, index: number) => {
      const old = VERSION_13_RADIAL_SLOTS[index];
      const next = DEFAULT_RADIAL_SLOTS[index];
      return old && next && isSlot(slot, old) ? { ...next } : slot;
    });
    result.radialMenu = { ...radialMenu, slots };
  }
  return result;
}

/**
 * Converts stored settings of an earlier version to the current one, one version at a time.
 * Values that are not a settings object pass through, so that the schema reports them.
 * Version 6 adds only `agents.includeSubagents`, so version 5 values pass to version 6 unchanged
 * and the new setting takes its default, off.
 */
export function migrateSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= SETTINGS_VERSION || !isRecord(values)) return values;
  let migrated = values;
  if (fromVersion < 2) migrated = migrateFromVersion1(migrated);
  if (fromVersion < 3) migrated = migrateFromVersion2(migrated);
  if (fromVersion < 4) migrated = migrateFromVersion3(migrated);
  if (fromVersion < 5) migrated = migrateFromVersion4(migrated);
  if (fromVersion < 7) migrated = migrateFromVersion6(migrated);
  if (fromVersion < 8) migrated = migrateFromVersion7(migrated);
  if (fromVersion < 9) migrated = migrateFromVersion8(migrated);
  if (fromVersion < 10) migrated = migrateFromVersion9(migrated);
  if (fromVersion < 11) migrated = migrateFromVersion10(migrated);
  if (fromVersion < 12) migrated = migrateFromVersion11(migrated);
  if (fromVersion < 13) migrated = migrateFromVersion12(migrated);
  if (fromVersion < 14) migrated = migrateFromVersion13(migrated);
  return migrated;
}

export const keypadSettings = defineSettings({
  id: SETTINGS_ID,
  scope: "host",
  version: SETTINGS_VERSION,
  schema: SettingsSchema,
  migrate: migrateSettings,
});

export const DEFAULT_SETTINGS: KeypadSettings = SettingsSchema.parse({});
