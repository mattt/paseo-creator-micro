import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ACTION_IDS } from "./actions";
import { KEY_STATES, LIGHT_EFFECTS, TOP_KEY_MODES } from "./settings";

/** The states of an agent that needs action, as the "next agent" lights show them. */
export const ACTION_STATES = ["failed", "needsInput", "done"] as const;

export const KeyLightSchema = z.object({
  color: z.string(),
  effect: z.enum(LIGHT_EFFECTS),
  brightness: z.number(),
});

export type KeyLight = z.infer<typeof KeyLightSchema>;

/** The keypad as the keypad app reports it. Fields the app omits are null. */
export const KeypadInfoSchema = z.object({
  connected: z.boolean(),
  transport: z.string().nullable(),
  firmware: z.string().nullable(),
  layer: z.number().nullable(),
  /** The layers whose inputs reach the app, from its keymap; null from an app that does not say. */
  inputLayers: z.array(z.number()).nullable(),
  battery: z.number().nullable(),
  charging: z.boolean().nullable(),
  lightsVisible: z.boolean().nullable(),
});

export type KeypadInfo = z.infer<typeof KeypadInfoSchema>;

export const BRIDGE_STATES = ["connected", "connecting", "waiting", "stopped"] as const;

/** What a top key shows: a workspace, an agent, a navigation action, or nothing. */
export const TOP_KEY_KINDS = ["workspace", "agent", "navigation", "off"] as const;

export const SETTINGS_STATES = ["loading", "ready", "error"] as const;

export const StatusSchema = z.object({
  /**
   * Whether the daemon code has valid settings. Keypad actions are off unless `ready`;
   * `error` says why the stored settings are invalid or could not be read.
   */
  settings: z.object({
    status: z.enum(SETTINGS_STATES),
    error: z.string().nullable(),
  }),
  /** Whether the plugin's daemon code has its Paseo connection yet. */
  paseoAttached: z.boolean(),
  bridge: z.object({
    state: z.enum(BRIDGE_STATES),
    socketPath: z.string(),
    appVersion: z.string().nullable(),
    error: z.string().nullable(),
  }),
  keypad: KeypadInfoSchema.nullable(),
  /** What the six top keys show and do. */
  topKeyMode: z.enum(TOP_KEY_MODES),
  /** The six top keys, as the top-key mode shows them. */
  keys: z.array(
    z.object({
      key: z.number(),
      kind: z.enum(TOP_KEY_KINDS),
      /** The key's workspace, or the workspace of its agent. */
      workspaceId: z.string().nullable(),
      /** The key's agent in the "recentAgents" mode. */
      agentId: z.string().nullable(),
      /** The key's action in the "navigation" mode. */
      action: z.enum(ACTION_IDS).nullable(),
      /** The workspace's title or name, or the agent's name. */
      title: z.string().nullable(),
      project: z.string().nullable(),
      /** The workspace's eligible agents, which decide its state; 1 for an agent's key. */
      agentCount: z.number(),
      state: z.enum(KEY_STATES),
      pinned: z.boolean(),
      selected: z.boolean(),
      /** Whether a press of the key can act now. */
      enabled: z.boolean(),
      light: KeyLightSchema,
    }),
  ),
  /** The underglow, as its source in the settings decides. */
  ambient: KeyLightSchema.nullable(),
  /**
   * The agent that "open next agent that needs action" would open next, which the action keys
   * with that light source and, by default, the underglow show; null when no agent needs action.
   */
  nextAgent: z
    .object({ id: z.string(), name: z.string(), state: z.enum(ACTION_STATES) })
    .nullable(),
  /** The action keys whose light the plugin sets, in key order, with their lights. */
  actionKeys: z.array(
    z.object({
      key: z.number(),
      source: z.enum(["nextActionableAgent"]),
      state: z.enum(ACTION_STATES).nullable(),
      light: KeyLightSchema,
    }),
  ),
  /**
   * The joystick's radial menu as PaseoMicro shows it: whether it is on, the name of the agent
   * that it acts on, and why each slot, clockwise from up, cannot act (null when it can).
   */
  radialMenu: z.object({
    enabled: z.boolean(),
    target: z.string().nullable(),
    blockers: z.array(z.string().nullable()),
  }),
  selectedWorkspaceId: z.string().nullable(),
  /**
   * Agents that need attention or have a pending request, each counted once.
   * Like the lights, it leaves out subagents unless the settings include them.
   */
  attentionCount: z.number(),
  /** Pending permission requests, across the same agents as `attentionCount`. */
  pendingPermissionCount: z.number(),
  lastInput: z.object({ description: z.string(), at: z.string() }).nullable(),
  lastAction: z
    .object({
      action: z.enum(ACTION_IDS),
      ok: z.boolean(),
      message: z.string(),
      /** The command went out, but no answer came, so it may or may not have run. */
      uncertain: z.boolean().optional(),
      at: z.string(),
    })
    .nullable(),
});

export type KeypadStatus = z.infer<typeof StatusSchema>;

/** Reports the bridge, the keypad, and the workspace keys. */
export const statusRpc = defineRpc({
  name: "keypad.status",
  input: z.object({}),
  output: StatusSchema,
});

/** Retries the bridge connection now instead of after the current backoff. */
export const reconnectRpc = defineRpc({
  name: "keypad.reconnect",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});
