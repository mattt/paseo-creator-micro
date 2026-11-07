// Made-up keypad status for the harness. The names are samples, not real workspaces.
import {
  NAVIGATION_KEY_ACTIONS,
  type KeypadSettings,
  type KeyState,
} from "../../../Plugin/shared/settings";
import type { KeyLight, KeypadStatus } from "../../../Plugin/shared/rpc";

const WORKSPACES: readonly { title: string; project: string; state: KeyState; agents: number }[] = [
  { title: "Fix login redirect", project: "web-app", state: "needsInput", agents: 2 },
  { title: "Add dark mode", project: "web-app", state: "running", agents: 1 },
  { title: "Release notes", project: "docs", state: "done", agents: 1 },
  { title: "Flaky upload test", project: "api", state: "failed", agents: 1 },
  { title: "Refactor billing", project: "api", state: "idle", agents: 1 },
  { title: "Onboarding copy", project: "docs", state: "running", agents: 1 },
];

function light(style: { color: string; effect: KeyLight["effect"]; brightness: number }): KeyLight {
  return { color: style.color, effect: style.effect, brightness: style.brightness };
}

export function sampleStatus(settings: KeypadSettings, params: URLSearchParams): KeypadStatus {
  const scenario = params.get("state") ?? "connected";
  const mode = settings.topKeys.mode;
  const off = light({ color: "#000000", effect: "off", brightness: 0 });
  const keys: KeypadStatus["keys"] = Array.from({ length: 6 }, (_, key) => {
    const sample = WORKSPACES[key];
    const base = {
      key,
      workspaceId: null,
      agentId: null,
      action: null,
      title: null,
      project: null,
      agentCount: 0,
      state: "empty" as KeyState,
      pinned: false,
      selected: false,
      enabled: false,
      light: off,
    };
    if (mode === "off") return { ...base, kind: "off" as const };
    if (mode === "navigation") {
      const action = NAVIGATION_KEY_ACTIONS[key] ?? "none";
      const enabled = key !== 1;
      return {
        ...base,
        kind: "navigation" as const,
        action,
        enabled,
        light: enabled ? light(settings.lights.navigation) : off,
      };
    }
    if (!sample || (mode === "pinned" && key > 2)) return { ...base, kind: "workspace" as const };
    const style =
      sample.state === "idle" ? settings.lights.selectedOff : settings.lights[sample.state];
    return {
      ...base,
      kind: mode === "recentAgents" ? ("agent" as const) : ("workspace" as const),
      workspaceId: `workspace-${key}`,
      agentId: mode === "recentAgents" ? `agent-${key}` : null,
      title: sample.title,
      project: sample.project,
      agentCount: mode === "recentAgents" ? 1 : sample.agents,
      state: sample.state,
      pinned: mode === "pinned",
      selected: key === 1,
      enabled: true,
      light: light(style),
    };
  });
  const connected = scenario !== "waiting" && scenario !== "disconnected";
  return {
    settings: { status: "ready", error: null },
    paseoAttached: true,
    bridge: {
      state: scenario === "waiting" ? "waiting" : "connected",
      socketPath: "~/Library/Application Support/PaseoMicro/bridge.sock",
      appVersion: "0.1.0",
      error: scenario === "waiting" ? "connect ENOENT bridge.sock" : null,
    },
    keypad:
      scenario === "waiting"
        ? null
        : {
            connected,
            transport: params.get("transport") ?? "USB",
            firmware: "0.6.3",
            layer: scenario === "layer" ? 1 : 4,
            inputLayers: [2, 4],
            battery: 64,
            charging: false,
            lightsVisible: scenario === "layer" ? false : true,
          },
    topKeyMode: mode,
    keys,
    ambient: light(settings.lights.underglowStyle),
    nextAgent:
      scenario === "idle"
        ? null
        : {
            id: "agent-0",
            name: "Fix login redirect",
            state: (params.get("next") ?? "needsInput") as "needsInput" | "failed" | "done",
          },
    actionKeys: [
      {
        key: 6,
        source: "nextActionableAgent",
        state: "needsInput",
        light: light(settings.lights.needsInput),
      },
    ],
    radialMenu: {
      enabled: settings.radialMenu.enabled,
      target: "Fix login redirect",
      blockers: settings.radialMenu.slots.map((_, index) =>
        index === 3 ? "No permission request" : null,
      ),
    },
    selectedWorkspaceId: "workspace-1",
    attentionCount: scenario === "idle" ? 0 : 1,
    pendingPermissionCount: 0,
    lastInput: { description: "key 7 press", at: new Date().toISOString() },
    lastAction: {
      action: "nextActionableAgent",
      ok: true,
      message: "Opened Fix login redirect",
      at: new Date().toISOString(),
    },
  };
}
