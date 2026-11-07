// Stand-ins for `@getpaseo/plugin/client`: settings kept in memory and RPCs answered
// with made-up sample data. Nothing here connects to Paseo, the daemon, or the keypad app.
import { useSyncExternalStore } from "react";
import { keypadSettings, SettingsSchema, type KeypadSettings } from "../../shared/settings";
import { sampleStatus } from "./sample";

const params = new URLSearchParams(location.search);

let values: KeypadSettings = SettingsSchema.parse({});
if (params.get("mode")) {
  values = {
    ...values,
    topKeys: { ...values.topKeys, mode: params.get("mode") as KeypadSettings["topKeys"]["mode"] },
  };
}
if (params.get("radial")) {
  const enabled = params.get("radial") === "on";
  values = { ...values, radialMenu: { ...values.radialMenu, enabled } };
}
let revision = 1;
const listeners = new Set<() => void>();
let snapshot = makeState();

function makeState() {
  return {
    status: "ready" as const,
    values,
    revision: String(revision),
    saving: false,
    saveError: null,
    save: async (next: KeypadSettings) => {
      values = SettingsSchema.parse(next);
      revision += 1;
      snapshot = makeState();
      for (const listener of listeners) listener();
      return true;
    },
    reset: async () => true,
    reload: async () => undefined,
  };
}

export function currentSettings(): KeypadSettings {
  return values;
}

export function useSettings(_definition: typeof keypadSettings) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export function useRpc(contract: { name: string }) {
  return async (_input: unknown) => {
    if (contract.name === "keypad.status") return sampleStatus(values, params);
    return { ok: true };
  };
}
