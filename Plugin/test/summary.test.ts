import { describe, expect, it } from "vite-plus/test";
import {
  connectionDetail,
  inputLayerList,
  joystickDetail,
  keycapLabel,
  keypadWorks,
  offInputLayer,
  sidebarLabel,
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
  it("says that the keypad is ready, whether or not agents need action", () => {
    const nextAgent = { id: "a", name: "Fix login", state: "needsInput" as const };
    expect(summarize(status({ attentionCount: 1, nextAgent }))).toBe("Keypad ready");
  });

  it("says only that the keypad is ready when no agent needs action", () => {
    for (const topKeyMode of [
      "navigation",
      "workspaces",
      "pinned",
      "recentAgents",
      "off",
    ] as const) {
      expect(summarize(status({ topKeyMode }))).toBe("Keypad ready");
    }
    expect(summarize(status({ paseoAttached: false }))).toBe("Keypad ready");
  });

  it("asks people to open the app when it is not running", () => {
    const bridge = {
      state: "waiting" as const,
      socketPath: "/tmp/b.sock",
      appVersion: null,
      error: "ENOENT",
    };
    expect(summarize(status({ bridge }))).toBe("Open Paseo Micro to use your keypad");
    expect(sidebarLabel(status({ bridge }))).toBe("Open Paseo Micro");
  });

  it("names no technical detail", () => {
    const off = { ...status().keypad!, layer: 1, inputLayers: [4], lightsVisible: false };
    const text = [summarize(status()), summarize(status({ keypad: off }))].join(" ");
    expect(text).not.toMatch(/socket|bridge|firmware|USB|0\.6\.3/i);
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
    expect(summarize(status({ keypad: off }))).toBe("Switch your keypad to layer 2 or 4");
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

describe("sidebarLabel", () => {
  it("names the next agent that needs action with Paseo's words for its state", () => {
    const next = (state: "needsInput" | "failed" | "done") => ({
      id: "a",
      name: "Fix login",
      state,
    });
    expect(sidebarLabel(status({ nextAgent: next("needsInput") }))).toBe("Needs input: Fix login");
    expect(sidebarLabel(status({ nextAgent: next("failed") }))).toBe("Failed: Fix login");
    expect(sidebarLabel(status({ nextAgent: next("done") }))).toBe("Ready to review: Fix login");
  });

  it("is short and calm when nothing needs action", () => {
    expect(sidebarLabel(status())).toBe("Keypad ready");
  });

  it("says what keeps the keypad from working before any agent", () => {
    const nextAgent = { id: "a", name: "Fix login", state: "needsInput" as const };
    const off = { ...status().keypad!, connected: false };
    expect(sidebarLabel(status({ keypad: off, nextAgent }))).toBe("Keypad not connected");
    expect(keypadWorks(status({ keypad: off }))).toBe(false);
    expect(keypadWorks(status())).toBe(true);
  });
});

describe("connectionDetail", () => {
  it("says how the keypad connects and its charge", () => {
    expect(connectionDetail(status())).toBe("Connected via USB · 64% battery");
    const charging = { ...status().keypad!, transport: "Bluetooth", charging: true };
    expect(connectionDetail(status({ keypad: charging }))).toBe(
      "Connected via Bluetooth · 64% battery, charging",
    );
    const unknown = { ...status().keypad!, transport: null, battery: null };
    expect(connectionDetail(status({ keypad: unknown }))).toBe("Connected");
  });

  it("says nothing while the keypad is not connected", () => {
    expect(connectionDetail(undefined)).toBeNull();
    const off = { ...status().keypad!, connected: false };
    expect(connectionDetail(status({ keypad: off }))).toBeNull();
  });
});

describe("keycapLabel", () => {
  it("shortens long action names and keeps short ones", () => {
    expect(keycapLabel("nextActionableAgent")).toBe("Next agent");
    expect(keycapLabel("pushToTalk")).toBe("Push to talk");
    expect(keycapLabel("none")).toBe("");
  });
});
