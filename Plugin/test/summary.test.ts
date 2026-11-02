import { describe, expect, it } from "vite-plus/test";
import {
  inputLayerList,
  joystickDetail,
  offInputLayer,
  summarize,
  topKeyLabel,
} from "../client/summary";
import type { KeypadStatus } from "../shared/rpc";

function status(overrides: Partial<KeypadStatus> = {}): KeypadStatus {
  return {
    settings: { status: "ready", error: null },
    paseoAttached: true,
    bridge: { state: "connected", socketPath: "/tmp/b.sock", appVersion: "0.1.0", error: null },
    keypad: {
      connected: true,
      transport: "USB",
      firmware: "0.6.3",
      layer: 4,
      inputLayers: [4],
      battery: 64,
      charging: false,
      lightsVisible: true,
    },
    topKeyMode: "navigation",
    keys: [],
    ambient: null,
    nextAgent: null,
    actionKeys: [],
    radialMenu: { enabled: true, target: null, blockers: [] },
    selectedWorkspaceId: null,
    attentionCount: 0,
    pendingPermissionCount: 0,
    lastInput: null,
    lastAction: null,
    ...overrides,
  };
}

describe("summarize", () => {
  it("counts agents that need you, not their requests", () => {
    expect(summarize(status({ attentionCount: 1, pendingPermissionCount: 1 }))).toBe(
      "Keypad: 1 agent needs you",
    );
    expect(summarize(status({ attentionCount: 2, pendingPermissionCount: 3 }))).toBe(
      "Keypad: 2 agents need you",
    );
  });

  const key = {
    kind: "workspace" as const,
    agentId: null,
    action: null,
    title: "w",
    project: "p",
    agentCount: 1,
    state: "done" as const,
    pinned: false,
    selected: false,
    enabled: true,
    light: { color: "#000000", effect: "off" as const, brightness: 0 },
  };

  it("counts the workspaces on the keys when no agent needs you", () => {
    const keys = [
      { ...key, key: 0, workspaceId: "w1" },
      { ...key, key: 1, workspaceId: "w2" },
      { ...key, key: 2, workspaceId: null },
    ];
    expect(summarize(status({ topKeyMode: "workspaces", keys }))).toBe("Keypad: 2 workspaces");
    expect(summarize(status({ topKeyMode: "pinned", keys: keys.slice(1) }))).toBe(
      "Keypad: 1 workspace",
    );
  });

  it("counts the agents on the keys in the recent agents mode, and says ready otherwise", () => {
    const keys = [
      { ...key, kind: "agent" as const, key: 0, workspaceId: "w", agentId: "a" },
      { ...key, kind: "agent" as const, key: 1, workspaceId: null, agentId: null },
    ];
    expect(summarize(status({ topKeyMode: "recentAgents", keys }))).toBe("Keypad: 1 agent");
    expect(summarize(status({ topKeyMode: "navigation" }))).toBe("Keypad ready");
    expect(summarize(status({ topKeyMode: "off" }))).toBe("Keypad ready");
  });

  it("puts a settings error first", () => {
    expect(
      summarize(
        status({
          settings: { status: "error", error: "bad" },
          bridge: { state: "waiting", socketPath: "", appVersion: null, error: null },
        }),
      ),
    ).toBe("Keypad actions off: settings error");
  });
});

describe("input layers", () => {
  const keypad = status().keypad!;

  it("says which layers the keypad needs when it is on another one", () => {
    const off = { ...keypad, layer: 1, inputLayers: [2, 4], lightsVisible: false };
    expect(summarize(status({ keypad: off }))).toBe("Keypad on layer 1, not layer 2 or 4");
    expect(offInputLayer(off)).toBe(true);
  });

  it("accepts any input layer, such as a Paseo layer 2", () => {
    const layer2 = { ...keypad, layer: 2, inputLayers: [2, 4], lightsVisible: true };
    expect(offInputLayer(layer2)).toBe(false);
    expect(summarize(status({ keypad: layer2 }))).toBe("Keypad ready");
  });

  it("counts layer 4 alone for an app that does not report the layers", () => {
    const old = { ...keypad, inputLayers: null, lightsVisible: null };
    expect(offInputLayer({ ...old, layer: 4 })).toBe(false);
    expect(offInputLayer({ ...old, layer: 2 })).toBe(true);
    expect(offInputLayer({ ...old, layer: null })).toBe(false);
  });

  it("lists layers for a sentence", () => {
    expect(inputLayerList([4])).toBe("layer 4");
    expect(inputLayerList([2, 4])).toBe("layer 2 or 4");
    expect(inputLayerList([1, 2, 4])).toBe("layer 1, 2 or 4");
    expect(inputLayerList(null)).toBe("layer 4");
    expect(inputLayerList([])).toBe("a Paseo layer");
  });
});

describe("joystickDetail", () => {
  it("shows a direction's prompt on one line, or that it has none", () => {
    expect(joystickDetail("sendPrompt", "  Continue.\n  Then test. ")).toBe(
      '"Continue. Then test."',
    );
    expect(joystickDetail("sendPrompt", " ")).toBe("No prompt");
  });

  it("shows the action of a direction that does not send a prompt", () => {
    expect(joystickDetail("thinkingUp", "")).toBe("More thinking");
    expect(joystickDetail("none", "")).toBe("—");
  });
});

describe("topKeyLabel", () => {
  it("names each top key by the mode, with or without a status", () => {
    expect(topKeyLabel("navigation", 0, undefined)).toBe("Go back");
    expect(topKeyLabel("navigation", 5, undefined)).toBe("Next project");
    expect(topKeyLabel("navigation", 3, undefined)).toBe("Previous workspace (Cmd+[)");
    expect(topKeyLabel("recentAgents", 0, undefined)).toBe("No agent");
    expect(topKeyLabel("workspaces", 0, undefined)).toBe("No workspace");
    expect(topKeyLabel("pinned", 0, undefined)).toBe("Not pinned");
    expect(topKeyLabel("off", 0, undefined)).toBe("Off");
  });
});
