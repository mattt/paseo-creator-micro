/**
 * The joystick's radial menu: eight slots at the cardinal and diagonal directions,
 * which PaseoMicro draws over Paseo's window while the stick is pushed,
 * and which picks a slot when the stick is released.
 * See the repository README's keypad layers section.
 */
import type { ActionId } from "./actions";

/** The number of slots, clockwise from up. */
export const RADIAL_SLOT_COUNT = 8;

/**
 * The SF Symbols that a slot may show: a short list of clearly different shapes,
 * so that each slot is easy to tell apart at a glance.
 * PaseoMicro refuses any other icon, and a Swift test checks that its list
 * (`RadialMenuSlot.icons`) matches this one, in order.
 */
export const RADIAL_MENU_ICONS = [
  "checkmark.circle",
  "xmark.circle",
  "play.circle",
  "stop.circle",
  "pause.circle",
  "testtube.2",
  "magnifyingglass",
  "arrow.triangle.branch",
  "list.bullet",
  "arrow.down.to.line",
  "arrow.uturn.backward",
  "arrow.uturn.backward.circle",
  "arrow.uturn.forward.circle",
  "arrow.clockwise",
  "sparkles",
  "hammer",
  "ant",
  "doc.text",
  "text.bubble",
  "questionmark.circle",
  "lightbulb",
  "flag",
  "trash",
  "paperplane",
  "mic",
  "brain",
  "bolt",
  "terminal",
  "shippingbox",
  "eye",
  "pencil",
  "folder",
  "star",
  "bookmark",
] as const;

export type RadialMenuIcon = (typeof RADIAL_MENU_ICONS)[number];

/** Plain names for the icons, for the settings screen, which cannot draw SF Symbols. */
export const RADIAL_MENU_ICON_LABELS: Readonly<Record<RadialMenuIcon, string>> = {
  "checkmark.circle": "Check mark",
  "xmark.circle": "X mark",
  "play.circle": "Play",
  "stop.circle": "Stop",
  "pause.circle": "Pause",
  "testtube.2": "Test tubes",
  magnifyingglass: "Magnifying glass",
  "arrow.triangle.branch": "Branch",
  "list.bullet": "List",
  "arrow.down.to.line": "Arrow to bottom",
  "arrow.uturn.backward": "U-turn arrow",
  "arrow.uturn.backward.circle": "Back arrow in a circle",
  "arrow.uturn.forward.circle": "Forward arrow in a circle",
  "arrow.clockwise": "Clockwise arrow",
  sparkles: "Sparkles",
  hammer: "Hammer",
  ant: "Ant",
  "doc.text": "Document",
  "text.bubble": "Speech bubble",
  "questionmark.circle": "Question mark",
  lightbulb: "Light bulb",
  flag: "Flag",
  trash: "Trash",
  paperplane: "Paper plane",
  mic: "Microphone",
  brain: "Brain",
  bolt: "Lightning bolt",
  terminal: "Terminal",
  shippingbox: "Box",
  eye: "Eye",
  pencil: "Pencil",
  folder: "Folder",
  star: "Star",
  bookmark: "Bookmark",
};

/** The longest slot label, in characters: room for one or two short words. PaseoMicro has the same limit. */
export const RADIAL_LABEL_MAX_LENGTH = 20;

/** The slots' directions, clockwise from up; slot 0 is up. */
export const RADIAL_SLOT_NAMES = [
  "Up",
  "Up-right",
  "Right",
  "Down-right",
  "Down",
  "Down-left",
  "Left",
  "Up-left",
] as const;

/** Slot colors that the settings screen offers, besides the menu's default (white). */
export const RADIAL_COLOR_PRESETS: readonly { readonly label: string; readonly color: string }[] = [
  { label: "Green", color: "#34C759" },
  { label: "Red", color: "#FF3B30" },
  { label: "Orange", color: "#FF9500" },
  { label: "Yellow", color: "#FFD60A" },
  { label: "Blue", color: "#0A84FF" },
  { label: "Purple", color: "#BF5AF2" },
  { label: "Teal", color: "#64D2FF" },
];

/** A slot as the settings store it before defaults apply. */
export interface RadialSlotDefault {
  readonly icon: RadialMenuIcon;
  readonly label: string;
  readonly color: string | null;
  readonly action: ActionId;
  readonly text: string;
}

/**
 * The default slots, clockwise from up: back, test, continue, commit, forward, review, stop, summary.
 */
export const DEFAULT_RADIAL_SLOTS: readonly RadialSlotDefault[] = [
  {
    icon: "arrow.uturn.backward.circle",
    label: "Back",
    color: null,
    action: "navigateBack",
    text: "",
  },
  {
    icon: "testtube.2",
    label: "Test",
    color: null,
    action: "sendPrompt",
    text: "Run the tests and fix any failures",
  },
  { icon: "play.circle", label: "Continue", color: null, action: "sendPrompt", text: "Continue" },
  {
    icon: "arrow.triangle.branch",
    label: "Commit",
    color: null,
    action: "sendPrompt",
    text: "Commit this work",
  },
  {
    icon: "arrow.uturn.forward.circle",
    label: "Forward",
    color: null,
    action: "navigateForward",
    text: "",
  },
  {
    icon: "magnifyingglass",
    label: "Review",
    color: null,
    action: "sendPrompt",
    text: "Review your diff for bugs",
  },
  { icon: "stop.circle", label: "Stop", color: "#FF9500", action: "stopAgent", text: "" },
  {
    icon: "list.bullet",
    label: "Summary",
    color: null,
    action: "sendPrompt",
    text: "Summarize where things stand and what's left",
  },
];

/**
 * The slots of settings version 13 that version 14 replaces where they were kept:
 * Approve up and Deny down, by slot index.
 */
export const VERSION_13_RADIAL_SLOTS: Readonly<Record<number, RadialSlotDefault>> = {
  0: {
    icon: "checkmark.circle",
    label: "Approve",
    color: "#34C759",
    action: "approvePermission",
    text: "",
  },
  4: { icon: "xmark.circle", label: "Deny", color: "#FF3B30", action: "denyPermission", text: "" },
};
