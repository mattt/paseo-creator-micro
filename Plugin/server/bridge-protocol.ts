/**
 * The bridge protocol between the keypad app (PaseoMicro.app) and its clients:
 * one JSON object per line on a Unix domain socket.
 * These types define the protocol alongside `Sources/PaseoMicroCore/BridgeProtocol.swift`.
 */
import { z } from "zod";
import type { LightEffect } from "../shared/settings";

export const BRIDGE_PROTOCOL_VERSION = 1;

/** The app's socket, relative to the home directory. */
export const DEFAULT_SOCKET_SUBPATH = "Library/Application Support/PaseoMicro/bridge.sock";

const KeypadStateSchema = z.looseObject({
  connected: z.boolean().default(false),
  transport: z.string().optional(),
  firmware: z.string().optional(),
  layer: z.number().optional(),
  battery: z.number().optional(),
  charging: z.boolean().optional(),
  /** The layers, from 1, whose inputs reach the app: those with vendor codes in the keymap. */
  inputLayers: z.array(z.number().int()).optional(),
  /** Whether the keypad is connected and on one of its input layers. */
  lightsVisible: z.boolean().optional(),
});

export type BridgeKeypadState = z.infer<typeof KeypadStateSchema>;

/**
 * Whether the keypad's inputs reach the plugin and its key lights show:
 * the app's `lightsVisible`. An app that does not report it counts layer 4, the stock
 * "ChatGPT" layer, or an unknown layer.
 */
export function onInputLayer(keypad: BridgeKeypadState | null | undefined): boolean {
  if (!keypad?.connected) return false;
  return keypad.lightsVisible ?? (keypad.layer === undefined || keypad.layer === 4);
}

/**
 * Keys 0–12 are the keypad's keys. Keys 13–19 are the codes `AG13`–`AG19`,
 * which no key sends on the stock keymap and which have no lights;
 * a keymap can bind the joystick's sectors to them.
 */
const KeyInputSchema = z.object({
  kind: z.literal("key"),
  key: z.number().int().min(0).max(19),
  code: z.string().optional(),
  action: z.enum(["press", "release"]),
});

const DialInputSchema = z.object({
  kind: z.literal("dial"),
  action: z.enum(["clockwise", "counterclockwise", "press", "release"]),
});

const JoystickInputSchema = z.object({
  kind: z.literal("joystick"),
  /** 0..1, counterclockwise from east. */
  angle: z.number(),
  /** 0..1 from the center. */
  distance: z.number(),
  /** 0..7, or -1 at rest. */
  sector: z.number().int(),
});

/**
 * The joystick picked a slot of the radial menu that this client set:
 * slot 0 is up, and the others follow clockwise. Only the client that set the menu receives it.
 */
const RadialInputSchema = z.object({
  kind: z.literal("radial"),
  slot: z.number().int().min(0).max(7),
});

export const BridgeInputSchema = z.discriminatedUnion("kind", [
  KeyInputSchema,
  DialInputSchema,
  JoystickInputSchema,
  RadialInputSchema,
]);

export type BridgeInput = z.infer<typeof BridgeInputSchema>;
export type KeyInput = z.infer<typeof KeyInputSchema>;
export type DialInput = z.infer<typeof DialInputSchema>;
export type JoystickInput = z.infer<typeof JoystickInputSchema>;
export type RadialInput = z.infer<typeof RadialInputSchema>;

export const AppMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int(),
    app: z.looseObject({ version: z.string() }),
    keypad: KeypadStateSchema,
    /**
     * The workspace that the plugin last stored with `setSelection`, which the app keeps
     * across plugin reloads; missing when none is stored or from an app without the command.
     * A value of another type reads as null rather than failing the hello.
     */
    selectedWorkspaceId: z.string().nullish().catch(null),
  }),
  z.object({ type: z.literal("keypad"), keypad: KeypadStateSchema }),
  z.object({ type: z.literal("input"), input: BridgeInputSchema }),
  z.object({
    type: z.literal("result"),
    id: z.number().int(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
]);

export type AppMessage = z.infer<typeof AppMessageSchema>;

export type ParsedLine =
  | { kind: "message"; message: AppMessage }
  | { kind: "ignored"; type: string }
  | { kind: "malformed"; reason: string };

const KNOWN_TYPES = new Set(["hello", "keypad", "input", "result"]);

/**
 * Parses one line from the app.
 * A well-formed object of an unknown type is ignored, so that a newer app can add messages.
 */
export function parseAppLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "malformed", reason: "not JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "malformed", reason: "not a JSON object" };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return { kind: "malformed", reason: "no type" };
  if (!KNOWN_TYPES.has(type)) return { kind: "ignored", type };
  const parsed = AppMessageSchema.safeParse(value);
  if (!parsed.success) {
    return { kind: "malformed", reason: `invalid ${type}: ${parsed.error.issues[0]?.message}` };
  }
  return { kind: "message", message: parsed.data };
}

export interface BridgeKeyLight {
  key: number;
  color: string;
  brightness: number;
  effect: LightEffect;
  speed: number;
}

export interface BridgeZoneLight {
  color: string;
  effect: LightEffect;
  brightness: number;
  speed: number;
}

/** A slot of the radial menu as PaseoMicro draws it; `icon` is one of `RADIAL_MENU_ICONS`. */
export interface BridgeRadialSlot {
  icon: string;
  label: string;
  /** `#RRGGBB`, or left out for the menu's default color. */
  color?: string;
  /** Whether the slot can act now; PaseoMicro dims a slot that cannot and never picks it. */
  enabled: boolean;
}

/** Commands from a client to the app. The client assigns `id` when it wants a result. */
export type BridgeCommand =
  | { type: "setKeyLights"; lights: BridgeKeyLight[] }
  | { type: "setZones"; keys?: BridgeZoneLight; ambient?: BridgeZoneLight }
  | { type: "clearLights" }
  | { type: "getState" }
  | { type: "openURL"; url: string }
  /**
   * Sets the radial menu that the joystick opens, over the frontmost window of `bundleID`:
   * eight slots clockwise from up, and the name of the agent that it acts on.
   * Needs PaseoMicro with the radial menu.
   */
  | {
      type: "setRadialMenu";
      slots: BridgeRadialSlot[];
      target: string | null;
      bundleID: string;
    }
  /** Clears this client's radial menu, so that the joystick opens none. */
  | { type: "clearRadialMenu" }
  /**
   * Stores the selected workspace in the app, or clears it with null, so that the next
   * `hello` returns it after a plugin reload. Needs PaseoMicro with the `setSelection` command.
   */
  | { type: "setSelection"; workspaceId: string | null }
  | { type: "sendShortcut"; bundleID: string; shortcut: string; activate: boolean }
  /**
   * Scrolls the app's frontmost window by `lines` (positive down), at its horizontal center
   * and `fromTop` of its height from the top. Needs PaseoMicro with the `scroll` command.
   */
  | { type: "scroll"; bundleID: string; lines: number; activate: boolean; fromTop: number }
  /**
   * Scrolls the app's frontmost window toward the top or the bottom of its content, at the same point:
   * PaseoMicro posts a burst of about 1,000 lines in events of at most 100 lines.
   * Needs PaseoMicro with the `edge` field of the `scroll` command.
   */
  | {
      type: "scroll";
      bundleID: string;
      edge: ScrollEdge;
      activate: boolean;
      fromTop: number;
    };

/**
 * An edge of a window's content, toward which one `scroll` command scrolls.
 * The plugin sends only `bottom` by default, because upward bursts, which make Paseo load
 * older messages, crashed its conversation list.
 */
export type ScrollEdge = "top" | "bottom";

/** The most lines that one `scroll` command may scroll, in either direction. */
export const MAX_SCROLL_LINES = 100;

const MODIFIERS = new Set(["cmd", "shift", "option", "ctrl"]);
const NAMED_KEYS = new Set(["return", "escape", "space", "tab"]);

/** Whether a shortcut has the form the app accepts, such as `cmd+shift+d`, `cmd+[`, or `return`. */
export function isValidShortcut(shortcut: string): boolean {
  const parts = shortcut.split("+");
  const key = parts.pop();
  if (key === undefined || key === "") return false;
  const modifiers = new Set<string>();
  for (const modifier of parts) {
    if (!MODIFIERS.has(modifier) || modifiers.has(modifier)) return false;
    modifiers.add(modifier);
  }
  if (/^[a-z0-9[\]]$/.test(key) || NAMED_KEYS.has(key)) return true;
  const fn = /^f([1-9]|1[0-9]|20)$/.exec(key);
  return fn !== null;
}
