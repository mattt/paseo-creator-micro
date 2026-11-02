import { settingsRpc } from "@getpaseo/plugin";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { WORKSPACE_KEY_COUNT } from "../shared/keypad";
import { SETTINGS_ID, SettingsSchema, type KeypadSettings } from "../shared/settings";

type Rpc = PluginCommandCapabilities["rpc"];
type Pins = KeypadSettings["pins"];

const contracts = settingsRpc(SETTINGS_ID);

/** Pins a workspace to a key (0–5) and removes it from any other key. */
export function pinWorkspace(pins: Pins, workspaceId: string, slot: number): Pins {
  if (!Number.isInteger(slot) || slot < 0 || slot >= WORKSPACE_KEY_COUNT) {
    throw new Error(`Choose a key from 1 to ${WORKSPACE_KEY_COUNT}`);
  }
  return pins.map((pinned, index) =>
    index === slot ? workspaceId : pinned === workspaceId ? null : pinned,
  );
}

/** Removes a workspace's pin. */
export function unpinWorkspace(pins: Pins, workspaceId: string): Pins {
  return pins.map((pinned) => (pinned === workspaceId ? null : pinned));
}

/** Removes the pin of a key (0–5). */
export function unpinKey(pins: Pins, slot: number): Pins {
  return pins.map((pinned, index) => (index === slot ? null : pinned));
}

/** Parses "1"–"6" from a slash command or a title into a key index. */
export function parseKeyNumber(text: string): number {
  const number = Number(text.trim());
  if (!Number.isInteger(number) || number < 1 || number > WORKSPACE_KEY_COUNT) {
    throw new Error(
      `Give a key number from 1 to ${WORKSPACE_KEY_COUNT}, such as /keypad-pin-workspace 3`,
    );
  }
  return number - 1;
}

/**
 * Changes the pins in the stored settings from a Command Center item or slash command,
 * which cannot use the settings hook. Retries when another client saved first.
 */
export async function changePins(rpc: Rpc, change: (pins: Pins) => Pins): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await rpc(contracts.read, {});
    if (current.status !== "ready") {
      throw new Error(`The keypad settings are invalid: ${current.error}`);
    }
    const values = SettingsSchema.parse(current.values);
    const next: KeypadSettings = { ...values, pins: change(values.pins) };
    const result = await rpc(contracts.write, { revision: current.revision, values: next });
    if (result.status === "saved") return;
    if (result.status === "invalid") throw new Error(result.error);
  }
  throw new Error("The keypad settings changed while saving. Try again.");
}
