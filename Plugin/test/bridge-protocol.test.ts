import { describe, expect, it } from "vite-plus/test";
import { isValidShortcut, onInputLayer, parseAppLine } from "../server/bridge-protocol";

describe("isValidShortcut", () => {
  it("accepts the shortcuts that the keypad app accepts", () => {
    for (const shortcut of ["cmd+d", "cmd+shift+d", "return", "cmd+[", "cmd+]", "option+f20"]) {
      expect(isValidShortcut(shortcut)).toBe(true);
    }
  });

  it("refuses unknown keys and modifiers, repeats, and empty parts", () => {
    for (const shortcut of ["", "cmd+", "cmd+cmd+d", "hyper+d", "cmd+{", "cmd+enter", "f21"]) {
      expect(isValidShortcut(shortcut)).toBe(false);
    }
  });
});

describe("onInputLayer", () => {
  it("follows the app's lightsVisible, for any input layer", () => {
    expect(
      onInputLayer({ connected: true, layer: 2, inputLayers: [2, 4], lightsVisible: true }),
    ).toBe(true);
    expect(
      onInputLayer({ connected: true, layer: 4, inputLayers: [2], lightsVisible: false }),
    ).toBe(false);
    expect(onInputLayer({ connected: false, layer: 2, lightsVisible: true })).toBe(false);
    expect(onInputLayer(null)).toBe(false);
  });

  it("counts layer 4 or an unknown layer from an app that does not report lightsVisible", () => {
    expect(onInputLayer({ connected: true, layer: 4 })).toBe(true);
    expect(onInputLayer({ connected: true })).toBe(true);
    expect(onInputLayer({ connected: true, layer: 2 })).toBe(false);
  });
});

describe("parseAppLine", () => {
  it("reads the input layers of a keypad message and the unlit keys 13–19", () => {
    const keypad = parseAppLine(
      '{"type":"keypad","keypad":{"connected":true,"layer":2,"inputLayers":[2,4],"lightsVisible":true}}',
    );
    expect(keypad).toMatchObject({ kind: "message", message: { keypad: { inputLayers: [2, 4] } } });
    const key = parseAppLine(
      '{"type":"input","input":{"kind":"key","key":15,"code":"AG15","action":"press"}}',
    );
    expect(key).toMatchObject({ kind: "message", message: { input: { key: 15 } } });
    const beyond = parseAppLine(
      '{"type":"input","input":{"kind":"key","key":20,"action":"press"}}',
    );
    expect(beyond.kind).toBe("malformed");
  });

  it("reads the stored selection of a hello, and treats a missing or odd one as none", () => {
    const hello = (extra: string) =>
      parseAppLine(
        `{"type":"hello","protocol":1,"app":{"version":"0.1.0"},"keypad":{"connected":false}${extra}}`,
      );
    expect(hello(',"selectedWorkspaceId":"ws_1"')).toMatchObject({
      kind: "message",
      message: { selectedWorkspaceId: "ws_1" },
    });
    const bare = hello("");
    expect(bare.kind).toBe("message");
    expect(
      bare.kind === "message" && bare.message.type === "hello" && bare.message.selectedWorkspaceId,
    ).toBeFalsy();
    expect(hello(',"selectedWorkspaceId":7')).toMatchObject({
      kind: "message",
      message: { selectedWorkspaceId: null },
    });
  });
});
