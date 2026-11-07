/**
 * The Creator Micro 2 as the plugin sees it on an input layer: the stock "ChatGPT" layer (layer 4),
 * or another layer whose keymap has the same vendor codes, such as a Paseo layer 2.
 *
 * Keys 0–5 (`AG00`–`AG05`) show workspaces. Keys 6–12 (`ACT06`–`ACT12`), the dial,
 * and the joystick run configurable actions.
 * The dial has three gestures: a turn, a turn while it is held down, and a click
 * (a press and release with no turn between them).
 */

/** The number of keys that show workspaces, the keys with the firmware codes `AG00`–`AG05`. */
export const WORKSPACE_KEY_COUNT = 6;

/** The keypad's key indexes, in the order the keypad reports them. */
export const KEY_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * Key indexes by row, from the top of the keypad.
 * The rows have 2, 4, 4, and 3 keys. Whether the top row is wired right to left
 * is unconfirmed on firmware 0.6.3, so the picture follows the reported order.
 */
export const KEY_ROWS: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3, 4, 5],
  [6, 7, 8, 9],
  [10, 11, 12],
];

/** The keys that run actions, keys 6–12. */
export const ACTION_KEYS = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];

/** The inputs that can run an action. Workspace keys are not configurable. */
export const ACTION_INPUTS = [
  ...ACTION_KEYS,
  "dialClockwise",
  "dialCounterclockwise",
  "dialPress",
  "dialHeldClockwise",
  "dialHeldCounterclockwise",
  "joystickUp",
  "joystickDown",
  "joystickLeft",
  "joystickRight",
] as const;

export type ActionInput = (typeof ACTION_INPUTS)[number];

export const ACTION_INPUT_LABELS: Readonly<Record<ActionInput, string>> = {
  ACT06: "Key 7",
  ACT07: "Key 8",
  ACT08: "Key 9",
  ACT09: "Key 10",
  ACT10: "Key 11",
  ACT11: "Key 12",
  ACT12: "Key 13",
  dialClockwise: "Dial clockwise",
  dialCounterclockwise: "Dial counterclockwise",
  dialPress: "Dial click",
  dialHeldClockwise: "Dial held, clockwise",
  dialHeldCounterclockwise: "Dial held, counterclockwise",
  joystickUp: "Joystick up",
  joystickDown: "Joystick down",
  joystickLeft: "Joystick left",
  joystickRight: "Joystick right",
};

export type JoystickDirection = "joystickUp" | "joystickDown" | "joystickLeft" | "joystickRight";

/** The joystick's directions, clockwise from up. */
export const JOYSTICK_DIRECTIONS: readonly JoystickDirection[] = [
  "joystickUp",
  "joystickRight",
  "joystickDown",
  "joystickLeft",
];

/**
 * Keys that a keymap can bind to the joystick's four cardinal sectors, as the experimental Paseo layer 2 does:
 * its sectors at the firmware's angles 0.25, 0.5, 0.75, and 0 send `KV_OAI_AG15`–`KV_OAI_AG18`.
 * The firmware counts angles clockwise, so those are down, left, up, and right
 * (checked on the keypad on 2026-10-28).
 * The stock keymap sends no joystick events on layer 4 (checked 2026-10-28).
 * See the repository README's keypad layers section.
 */
export const JOYSTICK_KEYS: Readonly<Record<number, JoystickDirection>> = {
  15: "joystickDown",
  16: "joystickLeft",
  17: "joystickUp",
  18: "joystickRight",
};

/** Whether an action input is a key rather than the dial or the joystick. */
export function isActionKey(input: ActionInput): input is ActionKey {
  return (ACTION_KEYS as readonly string[]).includes(input);
}

/** The key index of an action key, such as 11 for `ACT11`. */
export function actionKeyIndex(input: ActionKey): number {
  return Number(input.slice(3));
}

/** The name of one or more keys for people, counted from 1, such as `Key 4` or `Keys 11 + 12`. */
export function keyName(...keys: readonly number[]): string {
  const numbers = keys.map((key) => key + 1).join(" + ");
  return keys.length === 1 ? `Key ${numbers}` : `Keys ${numbers}`;
}

/** The firmware code of a key, such as `AG03`, `ACT11`, or `AG15` for a key beyond the keypad's 13. */
export function keyCode(key: number): string {
  const padded = String(key).padStart(2, "0");
  return key < WORKSPACE_KEY_COUNT || key > 12 ? `AG${padded}` : `ACT${padded}`;
}

/** The action input of a key that does not show a workspace, or null for a workspace key or an unknown key. */
export function keyActionInput(key: number): ActionInput | null {
  if (!Number.isInteger(key) || key < WORKSPACE_KEY_COUNT || key > 12) return null;
  return keyCode(key) as ActionInput;
}
