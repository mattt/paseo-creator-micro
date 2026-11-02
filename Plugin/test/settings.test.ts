import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SETTINGS,
  keypadSettings,
  migrateSettings,
  SETTINGS_VERSION,
  SettingsSchema,
} from "../shared/settings";
import {
  DEFAULT_RADIAL_SLOTS,
  RADIAL_MENU_ICON_LABELS,
  RADIAL_MENU_ICONS,
} from "../shared/radial-menu";

describe("radial menu settings", () => {
  it("defaults to the approved menu, on, with opposite slots meaning opposite things", () => {
    const { radialMenu } = DEFAULT_SETTINGS;
    expect(radialMenu.enabled).toBe(true);
    expect(
      radialMenu.slots.map((slot) => [slot.icon, slot.label, slot.color, slot.action]),
    ).toEqual([
      ["arrow.uturn.backward.circle", "Back", null, "navigateBack"],
      ["testtube.2", "Test", null, "sendPrompt"],
      ["play.circle", "Continue", null, "sendPrompt"],
      ["arrow.triangle.branch", "Commit", null, "sendPrompt"],
      ["arrow.uturn.forward.circle", "Forward", null, "navigateForward"],
      ["magnifyingglass", "Review", null, "sendPrompt"],
      ["stop.circle", "Stop", "#FF9500", "stopAgent"],
      ["list.bullet", "Summary", null, "sendPrompt"],
    ]);
    expect(radialMenu.slots.map((slot) => slot.text)).toEqual([
      "",
      "Run the tests and fix any failures",
      "Continue",
      "Commit this work",
      "",
      "Review your diff for bugs",
      "",
      "Summarize where things stand and what's left",
    ]);
    // The defaults are copies, so that changing one settings document never changes another.
    expect(SettingsSchema.parse({}).radialMenu.slots[0]).not.toBe(radialMenu.slots[0]);
  });

  it("offers each curated icon once and only those", () => {
    expect(new Set(RADIAL_MENU_ICONS).size).toBe(RADIAL_MENU_ICONS.length);
    expect(Object.keys(RADIAL_MENU_ICON_LABELS)).toEqual([...RADIAL_MENU_ICONS]);
    for (const slot of DEFAULT_RADIAL_SLOTS) expect(RADIAL_MENU_ICONS).toContain(slot.icon);
  });

  it("refuses a menu without eight slots, an unknown icon, a bad label, or a bad color", () => {
    const slot = { ...DEFAULT_RADIAL_SLOTS[0]! };
    const parse = (slots: unknown[]) => SettingsSchema.safeParse({ radialMenu: { slots } }).success;
    const eight = (change: object) => [{ ...slot, ...change }, ...DEFAULT_RADIAL_SLOTS.slice(1)];
    expect(parse(eight({}))).toBe(true);
    expect(parse(DEFAULT_RADIAL_SLOTS.slice(1))).toBe(false);
    expect(parse(eight({ icon: "applelogo" }))).toBe(false);
    expect(parse(eight({ label: " " }))).toBe(false);
    expect(parse(eight({ label: "A label that is far too long" }))).toBe(false);
    expect(parse(eight({ color: "green" }))).toBe(false);
    const lower = SettingsSchema.parse({ radialMenu: { slots: eight({ color: "#34c759" }) } });
    expect(lower.radialMenu.slots[0]?.color).toBe("#34C759");
  });
});

describe("SettingsSchema", () => {
  it("produces a complete document from nothing", () => {
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.pins).toEqual([null, null, null, null, null, null]);
    expect(DEFAULT_SETTINGS.connection).toEqual({
      socketPath: "",
      cliPath: "",
      paseoBundleId: "sh.paseo.desktop",
    });
    expect(DEFAULT_SETTINGS.pushToTalk).toEqual({ sendReturnOnRelease: false, returnDelayMs: 600 });
    expect(DEFAULT_SETTINGS.lights.underglowSource).toBe("nextActionableAgent");
    expect(DEFAULT_SETTINGS.lights.actionKeys).toEqual({
      ACT06: "nextActionableAgent",
      ACT07: "none",
      ACT08: "none",
      ACT09: "none",
      ACT10: "none",
      ACT11: "none",
      ACT12: "none",
    });
    expect(DEFAULT_SETTINGS.lights.underglowStyle).toEqual({
      color: "#FFD000",
      effect: "breathing",
      brightness: 0.4,
      speed: 0.5,
    });
    expect(DEFAULT_SETTINGS.bindings.dialPress.action).toBe("jumpToBottom");
    expect(DEFAULT_SETTINGS.scroll).toEqual({ lines: 3, fastLines: 15, fromTop: 0.4 });
    expect(DEFAULT_SETTINGS.lights.meter).toEqual({
      color: "#A05CFF",
      effect: "solid",
      brightness: 0.6,
      speed: 0.5,
    });
    expect(DEFAULT_SETTINGS.lights.meterOff.effect).toBe("off");
    expect(DEFAULT_SETTINGS.lights.failure).toEqual({
      color: "#FF2D2D",
      effect: "solid",
      brightness: 0.8,
      speed: 0.5,
    });
  });

  it("rejects scroll lines and positions out of range", () => {
    const parse = (scroll: unknown) => SettingsSchema.safeParse({ scroll }).success;
    expect(parse({ lines: 1, fromTop: 0.1 })).toBe(true);
    expect(parse({ lines: 20, fromTop: 0.9 })).toBe(true);
    expect(parse({ lines: 0 })).toBe(false);
    expect(parse({ lines: 21 })).toBe(false);
    expect(parse({ lines: 2.5 })).toBe(false);
    expect(parse({ fromTop: 0 })).toBe(false);
    expect(parse({ fromTop: 1 })).toBe(false);
  });

  it("fills missing fields of a partial document", () => {
    const settings = SettingsSchema.parse({
      lights: { done: { color: "#123456", effect: "solid", brightness: 0.3 } },
      pushToTalk: { sendReturnOnRelease: true },
    });
    expect(settings.lights.done).toEqual({
      color: "#123456",
      effect: "solid",
      brightness: 0.3,
      speed: 0.5,
    });
    expect(settings.lights.running.color).toBe("#2D7BFF");
    expect(settings.pushToTalk).toEqual({ sendReturnOnRelease: true, returnDelayMs: 600 });
  });

  it("rejects key groups that overlap, have one key, or name the dial", () => {
    const parse = (keyGroups: unknown) => SettingsSchema.safeParse({ keyGroups }).success;
    expect(parse([])).toBe(true);
    expect(
      parse([
        ["ACT06", "ACT07"],
        ["ACT10", "ACT11", "ACT12"],
      ]),
    ).toBe(true);
    expect(
      parse([
        ["ACT10", "ACT11"],
        ["ACT11", "ACT12"],
      ]),
    ).toBe(false);
    expect(parse([["ACT10"]])).toBe(false);
    expect(parse([["ACT10", "dialPress"]])).toBe(false);
  });

  it("rejects bad colors, actions, and pin lists", () => {
    expect(
      SettingsSchema.safeParse({
        lights: { done: { color: "green", effect: "solid", brightness: 1 } },
      }).success,
    ).toBe(false);
    expect(SettingsSchema.safeParse({ bindings: { ACT06: { action: "nextModel" } } }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ pins: [null] }).success).toBe(false);
  });

  it("survives a round trip through JSON", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as unknown;
    expect(SettingsSchema.parse(stored)).toEqual(DEFAULT_SETTINGS);
  });
});

/** Settings as the agent-key version stored them: every field written out by its schema. */
const VERSION_1 = {
  bindings: {
    ACT06: { action: "openNextUnread", text: "" },
    ACT07: { action: "approvePermission", text: "" },
    ACT08: { action: "denyPermission", text: "" },
    ACT09: { action: "stopAgent", text: "" },
    ACT10: { action: "pushToTalk", text: "" },
    ACT11: { action: "toggleVoiceMode", text: "" },
    ACT12: { action: "sendPrompt", text: "Continue." },
    dialClockwise: { action: "selectNextAgent", text: "" },
    dialCounterclockwise: { action: "selectPreviousAgent", text: "" },
    dialPress: { action: "openSelectedAgent", text: "" },
    joystickUp: { action: "thinkingUp", text: "" },
    joystickDown: { action: "thinkingDown", text: "" },
    joystickLeft: { action: "selectPreviousAgent", text: "" },
    joystickRight: { action: "selectNextAgent", text: "" },
  },
  pins: ["agent-1", null, null, "agent-2", null, null],
  lights: {
    permission: { color: "#FF2D2D", effect: "breathing", brightness: 0.6, speed: 0.6 },
    error: { color: "#FF2D2D", effect: "solid", brightness: 0.5, speed: 0.5 },
    unread: { color: "#2D7BFF", effect: "solid", brightness: 0.5, speed: 0.5 },
    running: { color: "#FFB000", effect: "solid", brightness: 0.5, speed: 0.5 },
    idle: { color: "#2DFF6A", effect: "solid", brightness: 0.12, speed: 0.5 },
    empty: { color: "#000000", effect: "off", brightness: 0, speed: 0.5 },
    selectedBrightness: 3,
    ambient: false,
    ambientBrightness: 0.25,
    keysZone: { color: "#FF00FF", effect: "solid", brightness: 0.2, speed: 0.5 },
  },
  pushToTalk: { sendReturnOnRelease: true, returnDelayMs: 800 },
  connection: { socketPath: "~/b.sock", cliPath: "/opt/paseo", paseoBundleId: "sh.paseo.dev" },
};

/** Settings as version 2 stored them, with the version 2 default bindings. */
const VERSION_2 = {
  bindings: {
    ACT06: { action: "openNextUnread", text: "" },
    ACT07: { action: "approvePermission", text: "" },
    ACT08: { action: "denyPermission", text: "" },
    ACT09: { action: "stopAgent", text: "" },
    ACT10: { action: "pushToTalk", text: "" },
    ACT11: { action: "toggleVoiceMode", text: "" },
    ACT12: { action: "none", text: "" },
    dialClockwise: { action: "selectNextWorkspace", text: "" },
    dialCounterclockwise: { action: "selectPreviousWorkspace", text: "" },
    dialPress: { action: "openSelectedWorkspace", text: "" },
    joystickUp: { action: "thinkingUp", text: "" },
    joystickDown: { action: "thinkingDown", text: "" },
    joystickLeft: { action: "selectPreviousWorkspace", text: "" },
    joystickRight: { action: "selectNextWorkspace", text: "" },
  },
  pins: ["w1", null, null, null, null, null],
  lights: { done: { color: "#00FF00", effect: "solid", brightness: 0.3, speed: 0.5 } },
  pushToTalk: { sendReturnOnRelease: true, returnDelayMs: 800 },
};

/** Settings as version 3 stored them, with the version 3 default bindings. */
const VERSION_3 = {
  bindings: {
    ...VERSION_2.bindings,
    ACT06: { action: "nextStuckWorkspace", text: "" },
    ACT07: { action: "navigateBack", text: "" },
    ACT08: { action: "previousWorkspace", text: "" },
    ACT09: { action: "nextWorkspace", text: "" },
    ACT11: { action: "pushToTalk", text: "" },
    ACT12: { action: "toggleVoiceMode", text: "" },
  },
  keyGroups: [["ACT10", "ACT11"]],
  pins: ["w1", null, null, null, null, null],
  pushToTalk: { sendReturnOnRelease: false, returnDelayMs: 900 },
};

/** Settings as version 4 stored them, with the version 4 default bindings. */
const VERSION_4 = {
  bindings: {
    ...VERSION_3.bindings,
    ACT06: { action: "nextActionableAgent", text: "" },
    ACT12: { action: "submit", text: "" },
  },
  keyGroups: [["ACT10", "ACT11"]],
  pins: [null, "w2", null, null, null, null],
  pushToTalk: { sendReturnOnRelease: false, returnDelayMs: 700 },
};

describe("migrateSettings", () => {
  it("is part of the settings definition, at version 14", () => {
    expect(keypadSettings.version).toBe(SETTINGS_VERSION);
    expect(SETTINGS_VERSION).toBe(14);
    expect(keypadSettings.migrate).toBe(migrateSettings);
  });

  it("loads stored agent-key settings instead of rejecting them", () => {
    expect(SettingsSchema.safeParse(VERSION_1).success).toBe(false);
    const settings = SettingsSchema.parse(migrateSettings(VERSION_1, 1));
    // The agent selection actions became workspace selection in version 2,
    // which were the defaults until version 5 moved them to the dial's and joystick's new actions,
    // version 7 moved the click to the edge jump, and version 9 made it jump only to the bottom.
    expect(settings.bindings.dialClockwise.action).toBe("scrollDown");
    expect(settings.bindings.dialCounterclockwise.action).toBe("scrollUp");
    expect(settings.bindings.dialPress.action).toBe("jumpToBottom");
    expect(settings.bindings.joystickLeft).toEqual({ action: "sendPrompt", text: "" });
    expect(settings.bindings.joystickRight).toEqual({ action: "sendPrompt", text: "" });
    expect(settings.bindings.ACT12).toEqual({ action: "sendPrompt", text: "Continue." });
  });

  it("gives agent-key settings the current defaults where they kept the old ones", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_1, 1));
    expect(settings.bindings.ACT06.action).toBe("nextActionableAgent");
    expect(settings.bindings.ACT09.action).toBe("newAgent");
    expect(settings.bindings.ACT11.action).toBe("pushToTalk");
    expect(settings.keyGroups).toEqual([["ACT10", "ACT11"]]);
  });

  it("drops agent pins and the old state colors", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_1, 1));
    expect(settings.pins).toEqual(DEFAULT_SETTINGS.pins);
    for (const state of ["failed", "needsInput", "running", "done", "idle", "empty"] as const) {
      expect(settings.lights[state]).toEqual(DEFAULT_SETTINGS.lights[state]);
    }
    expect(settings.lights).not.toHaveProperty("permission");
  });

  it("keeps the brightness, the other keys, the underglow choice, push to talk, and the connection", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_1, 1));
    expect(settings.lights.selectedBrightness).toBe(3);
    expect(settings.lights.keysZone.color).toBe("#FF00FF");
    expect(settings.lights.underglowSource).toBe("off");
    expect(settings.lights.underglowStyle).toEqual({
      ...DEFAULT_SETTINGS.lights.underglowStyle,
      brightness: 0.25,
    });
    expect(settings.pushToTalk).toEqual(VERSION_1.pushToTalk);
    expect(settings.connection).toEqual(VERSION_1.connection);
  });

  it("migrates an empty or partial version 1 document to the defaults", () => {
    expect(SettingsSchema.parse(migrateSettings({}, 1))).toEqual(DEFAULT_SETTINGS);
    const partial = SettingsSchema.parse(
      migrateSettings({ bindings: { ACT06: { action: "openSelectedAgent" } } }, 1),
    );
    expect(partial.bindings.ACT06.action).toBe("openSelectedWorkspace");
  });

  it("passes through values that are not a settings object, so the schema reports them", () => {
    expect(migrateSettings("broken", 1)).toBe("broken");
    expect(migrateSettings(null, 1)).toBeNull();
  });

  it("moves version 2 bindings that kept their defaults to the current defaults", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_2, 2));
    expect(settings.bindings).toEqual(DEFAULT_SETTINGS.bindings);
    expect(settings.keyGroups).toEqual([["ACT10", "ACT11"]]);
    expect(settings.lights.selectedOff).toEqual(DEFAULT_SETTINGS.lights.selectedOff);
  });

  it("keeps version 2 bindings that the user changed, and everything else", () => {
    const changed = {
      ...VERSION_2,
      bindings: {
        ...VERSION_2.bindings,
        ACT07: { action: "thinkingUp", text: "" },
        ACT09: { action: "sendPrompt", text: "Continue." },
        ACT12: { action: "stopAgent", text: "" },
        dialPress: { action: "openNextUnread", text: "" },
      },
    };
    const settings = SettingsSchema.parse(migrateSettings(changed, 2));
    expect(settings.bindings.ACT06.action).toBe("nextActionableAgent");
    expect(settings.bindings.ACT07.action).toBe("thinkingUp");
    // Key 9 kept its default through version 13, so version 14 makes it deny.
    expect(settings.bindings.ACT08.action).toBe("denyPermission");
    expect(settings.bindings.ACT09).toEqual({ action: "sendPrompt", text: "Continue." });
    expect(settings.bindings.ACT11.action).toBe("pushToTalk");
    expect(settings.bindings.ACT12.action).toBe("stopAgent");
    expect(settings.bindings.dialPress.action).toBe("nextActionableAgent");
    expect(settings.pins).toEqual(VERSION_2.pins);
    expect(settings.lights.done.color).toBe("#00FF00");
    expect(settings.pushToTalk).toEqual(VERSION_2.pushToTalk);
  });

  it("migrates an empty or partial version 2 document", () => {
    expect(SettingsSchema.parse(migrateSettings({}, 2))).toEqual(DEFAULT_SETTINGS);
    const partial = SettingsSchema.parse(
      migrateSettings({ bindings: { ACT11: { action: "toggleVoiceMode" } } }, 2),
    );
    expect(partial.bindings).toEqual(DEFAULT_SETTINGS.bindings);
  });

  it("moves version 3 bindings that kept their defaults to the version 4 defaults", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_3, 3));
    expect(settings.bindings).toEqual(DEFAULT_SETTINGS.bindings);
    expect(settings.bindings.ACT06.action).toBe("nextActionableAgent");
    expect(settings.bindings.ACT12.action).toBe("submit");
    expect(Object.values(settings.bindings).map((binding) => binding.action)).not.toContain(
      "toggleVoiceMode",
    );
    expect(settings.pins).toEqual(VERSION_3.pins);
    expect(settings.pushToTalk).toEqual(VERSION_3.pushToTalk);
  });

  it("keeps version 3 bindings that the user changed", () => {
    const changed = {
      ...VERSION_3,
      bindings: {
        ...VERSION_3.bindings,
        ACT06: { action: "approvePermission", text: "" },
        ACT12: { action: "sendPrompt", text: "Continue." },
        dialPress: { action: "toggleVoiceMode", text: "" },
        joystickUp: { action: "nextStuckWorkspace", text: "" },
      },
    };
    const settings = SettingsSchema.parse(migrateSettings(changed, 3));
    expect(settings.bindings.ACT06.action).toBe("approvePermission");
    expect(settings.bindings.ACT12).toEqual({ action: "sendPrompt", text: "Continue." });
    expect(settings.bindings.dialPress.action).toBe("toggleVoiceMode");
    expect(settings.bindings.joystickUp.action).toBe("nextStuckWorkspace");
    expect(settings.bindings.ACT07.action).toBe("approvePermission");
  });

  it("folds open next unread agent into open next agent that needs action", () => {
    const stored = { bindings: { joystickDown: { action: "openNextUnread", text: "" } } };
    expect(SettingsSchema.safeParse(stored).success).toBe(false);
    const settings = SettingsSchema.parse(migrateSettings(stored, 3));
    expect(settings.bindings.joystickDown.action).toBe("nextActionableAgent");
  });

  it("migrates an empty or partial version 3 document", () => {
    expect(SettingsSchema.parse(migrateSettings({}, 3))).toEqual(DEFAULT_SETTINGS);
    const partial = SettingsSchema.parse(
      migrateSettings({ bindings: { ACT12: { action: "toggleVoiceMode" } } }, 3),
    );
    expect(partial.bindings).toEqual(DEFAULT_SETTINGS.bindings);
  });

  it("moves version 4 dial and joystick bindings that kept their defaults to the current defaults", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_4, 4));
    expect(settings.bindings).toEqual(DEFAULT_SETTINGS.bindings);
    expect(settings.bindings.dialClockwise.action).toBe("scrollDown");
    expect(settings.bindings.dialCounterclockwise.action).toBe("scrollUp");
    expect(settings.bindings.dialPress.action).toBe("jumpToBottom");
    expect(settings.bindings.dialHeldClockwise.action).toBe("scrollDownFast");
    expect(settings.bindings.dialHeldCounterclockwise.action).toBe("scrollUpFast");
    for (const input of ["joystickUp", "joystickDown", "joystickLeft", "joystickRight"] as const) {
      expect(settings.bindings[input]).toEqual({ action: "sendPrompt", text: "" });
    }
    expect(Object.values(settings.bindings).map((binding) => binding.action)).not.toContain(
      "selectNextWorkspace",
    );
    expect(settings.scroll).toEqual(DEFAULT_SETTINGS.scroll);
    expect(settings.lights.meter).toEqual(DEFAULT_SETTINGS.lights.meter);
    expect(settings.lights.failure).toEqual(DEFAULT_SETTINGS.lights.failure);
    expect(settings.pins).toEqual(VERSION_4.pins);
    expect(settings.pushToTalk).toEqual(VERSION_4.pushToTalk);
  });

  it("keeps version 4 dial and joystick bindings that the user changed", () => {
    const changed = {
      ...VERSION_4,
      bindings: {
        ...VERSION_4.bindings,
        dialClockwise: { action: "nextWorkspace", text: "" },
        dialPress: { action: "pushToTalk", text: "" },
        joystickUp: { action: "sendPrompt", text: "Continue." },
        joystickLeft: { action: "stopAgent", text: "" },
      },
    };
    const settings = SettingsSchema.parse(migrateSettings(changed, 4));
    expect(settings.bindings.dialClockwise.action).toBe("nextWorkspace");
    expect(settings.bindings.dialCounterclockwise.action).toBe("scrollUp");
    expect(settings.bindings.dialPress.action).toBe("pushToTalk");
    expect(settings.bindings.joystickUp).toEqual({ action: "sendPrompt", text: "Continue." });
    expect(settings.bindings.joystickLeft.action).toBe("stopAgent");
    expect(settings.bindings.joystickDown).toEqual({ action: "sendPrompt", text: "" });
  });

  it("never sends text left in a version 4 binding that moves to send prompt", () => {
    const stored = { bindings: { joystickUp: { action: "thinkingUp", text: "Old prompt." } } };
    const settings = SettingsSchema.parse(migrateSettings(stored, 4));
    expect(settings.bindings.joystickUp).toEqual({ action: "sendPrompt", text: "" });
  });

  it("migrates an empty or partial version 4 document", () => {
    expect(SettingsSchema.parse(migrateSettings({}, 4))).toEqual(DEFAULT_SETTINGS);
    const partial = SettingsSchema.parse(
      migrateSettings({ bindings: { dialPress: { action: "openSelectedWorkspace" } } }, 4),
    );
    expect(partial.bindings).toEqual(DEFAULT_SETTINGS.bindings);
  });

  it("keeps version 5 settings and leaves subagents out by default", () => {
    const stored = {
      bindings: {
        ACT06: { action: "stopAgent" },
        joystickUp: { action: "sendPrompt", text: "Go" },
      },
      pins: [null, "w2", null, null, null, null],
      lights: { underglow: false },
      scroll: { lines: 5 },
    };
    const migrated = migrateSettings(structuredClone(stored), 5);
    expect(migrated).toEqual({
      ...stored,
      lights: { underglowSource: "off" },
      topKeys: { mode: "navigation" },
    });
    const settings = SettingsSchema.parse(migrated);
    expect(settings.agents).toEqual({ includeSubagents: false });
    expect(settings.bindings.ACT06).toEqual({ action: "stopAgent", text: "" });
    expect(settings.bindings.joystickUp).toEqual({ action: "sendPrompt", text: "Go" });
    expect(settings.pins[1]).toBe("w2");
    expect(settings.lights.underglowSource).toBe("off");
    expect(settings.scroll.lines).toBe(5);
    expect(SettingsSchema.parse(migrateSettings({}, 5))).toEqual(DEFAULT_SETTINGS);
  });

  it("moves version 6 dial bindings that kept their defaults to the version 7 defaults", () => {
    const stored = {
      bindings: {
        dialClockwise: { action: "scrollDown", text: "" },
        dialCounterclockwise: { action: "scrollUp", text: "" },
        dialPress: { action: "focusComposer", text: "" },
        dialHeldClockwise: { action: "thinkingUp", text: "" },
        dialHeldCounterclockwise: { action: "thinkingDown", text: "" },
        joystickUp: { action: "sendPrompt", text: "Continue." },
      },
      scroll: { lines: 4, fromTop: 0.5 },
      agents: { includeSubagents: true },
    };
    const settings = SettingsSchema.parse(migrateSettings(stored, 6));
    expect(settings.bindings.dialPress.action).toBe("jumpToBottom");
    expect(settings.bindings.dialHeldClockwise.action).toBe("scrollDownFast");
    expect(settings.bindings.dialHeldCounterclockwise.action).toBe("scrollUpFast");
    expect(settings.bindings.dialClockwise.action).toBe("scrollDown");
    expect(settings.bindings.dialCounterclockwise.action).toBe("scrollUp");
    expect(settings.bindings.joystickUp).toEqual({ action: "sendPrompt", text: "Continue." });
    expect(settings.scroll).toEqual({ lines: 4, fastLines: 15, fromTop: 0.5 });
    expect(settings.agents.includeSubagents).toBe(true);
    expect(SettingsSchema.parse(migrateSettings({}, 6))).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps version 6 dial bindings that the user changed, and the thinking actions stay assignable", () => {
    const stored = {
      bindings: {
        dialPress: { action: "pushToTalk", text: "" },
        dialHeldClockwise: { action: "thinkingDown", text: "" },
        dialHeldCounterclockwise: { action: "none", text: "" },
        ACT07: { action: "thinkingUp", text: "" },
        ACT09: { action: "focusComposer", text: "" },
      },
    };
    const settings = SettingsSchema.parse(migrateSettings(stored, 6));
    expect(settings.bindings.dialPress.action).toBe("pushToTalk");
    expect(settings.bindings.dialHeldClockwise.action).toBe("thinkingDown");
    expect(settings.bindings.dialHeldCounterclockwise.action).toBe("none");
    expect(settings.bindings.ACT07.action).toBe("thinkingUp");
    expect(settings.bindings.ACT09.action).toBe("focusComposer");
  });

  it("moves a version 7 underglow at its default to the next agent that needs action", () => {
    const stored = {
      lights: {
        underglow: true,
        underglowStyle: { color: "#FF8800", effect: "solid", brightness: 0.2, speed: 0.5 },
        keysZone: { color: "#112233", effect: "solid", brightness: 0.1, speed: 0.5 },
      },
    };
    const migrated = migrateSettings(structuredClone(stored), 7) as { lights: object };
    expect(migrated.lights).not.toHaveProperty("underglow");
    const settings = SettingsSchema.parse(migrated);
    expect(settings.lights.underglowSource).toBe("nextActionableAgent");
    expect(settings.lights.underglowStyle.color).toBe("#FF8800");
    expect(settings.lights.keysZone.color).toBe("#112233");
    expect(settings.lights.actionKeys.ACT06).toBe("nextActionableAgent");
    expect(SettingsSchema.parse(migrateSettings({}, 7))).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps a version 7 underglow that the user turned off, off", () => {
    const settings = SettingsSchema.parse(migrateSettings({ lights: { underglow: false } }, 7));
    expect(settings.lights.underglowSource).toBe("off");
    expect(settings.lights.actionKeys.ACT06).toBe("nextActionableAgent");
  });

  it("moves a version 8 jump to the bottom, then the top, to the jump to the bottom", () => {
    const stored = {
      bindings: {
        dialPress: { action: "jumpToEdge", text: "" },
        ACT09: { action: "jumpToEdge", text: "" },
        dialClockwise: { action: "scrollUp", text: "" },
      },
      lights: { underglowSource: "off" },
    };
    expect(SettingsSchema.safeParse(stored).success).toBe(false);
    const settings = SettingsSchema.parse(migrateSettings(structuredClone(stored), 8));
    expect(settings.bindings.dialPress.action).toBe("jumpToBottom");
    expect(settings.bindings.ACT09.action).toBe("jumpToBottom");
    expect(settings.bindings.dialClockwise.action).toBe("scrollUp");
    expect(settings.lights.underglowSource).toBe("off");
    expect(SettingsSchema.parse(migrateSettings({}, 8))).toEqual(DEFAULT_SETTINGS);
  });

  it("refuses an unknown light source", () => {
    expect(SettingsSchema.safeParse({ lights: { underglowSource: "rainbow" } }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ lights: { actionKeys: { ACT06: "off" } } }).success).toBe(
      false,
    );
  });

  it("limits the fast scroll's lines to what one bridge scroll allows", () => {
    const parse = (fastLines: unknown) =>
      SettingsSchema.safeParse({ scroll: { fastLines } }).success;
    expect(parse(1)).toBe(true);
    expect(parse(100)).toBe(true);
    expect(parse(0)).toBe(false);
    expect(parse(101)).toBe(false);
    expect(parse(7.5)).toBe(false);
  });

  it("leaves subagents out by default and keeps the choice to include them", () => {
    expect(DEFAULT_SETTINGS.agents.includeSubagents).toBe(false);
    const included = SettingsSchema.parse({ agents: { includeSubagents: true } });
    expect(included.agents.includeSubagents).toBe(true);
  });

  it("turns the radial menu on with its defaults from version 9, and keeps the joystick's prompts", () => {
    const stored = {
      bindings: {
        joystickUp: { action: "sendPrompt", text: "Continue." },
        joystickLeft: { action: "thinkingDown", text: "" },
      },
      scroll: { lines: 5 },
    };
    expect(SettingsSchema.safeParse(stored).success).toBe(true);
    const settings = SettingsSchema.parse(migrateSettings(structuredClone(stored), 9));
    expect(settings.radialMenu).toEqual(DEFAULT_SETTINGS.radialMenu);
    expect(settings.radialMenu.enabled).toBe(true);
    expect(settings.bindings.joystickUp).toEqual({ action: "sendPrompt", text: "Continue." });
    expect(settings.bindings.joystickLeft.action).toBe("thinkingDown");
    expect(settings.scroll.lines).toBe(5);
    expect(SettingsSchema.parse(migrateSettings({}, 9))).toEqual(DEFAULT_SETTINGS);
  });

  it("gives settings from every earlier version the radial menu's defaults", () => {
    for (const version of [1, 4, 6, 8]) {
      const settings = SettingsSchema.parse(migrateSettings({}, version));
      expect(settings.radialMenu).toEqual(DEFAULT_SETTINGS.radialMenu);
    }
  });

  it("leaves current settings alone", () => {
    const current = { pins: ["w1", null, null, null, null, null] };
    expect(migrateSettings(current, SETTINGS_VERSION)).toBe(current);
  });

  it("drops the period from the radial menu's default Continue prompt, and keeps a changed one", () => {
    const stored = (text: string) => ({
      radialMenu: {
        enabled: true,
        slots: DEFAULT_RADIAL_SLOTS.map((slot) =>
          slot.label === "Continue" ? { ...slot, text } : { ...slot },
        ),
      },
    });
    const continueText = (values: unknown) =>
      SettingsSchema.parse(migrateSettings(values, 10)).radialMenu.slots.find(
        (slot) => slot.label === "Continue",
      )?.text;
    expect(continueText(stored("Continue."))).toBe("Continue");
    expect(continueText(stored("Keep going."))).toBe("Keep going.");
    expect(continueText({})).toBe("Continue");
  });

  it("drops the final period from the radial menu's other default prompts, and keeps changed ones", () => {
    const old: Record<string, string> = {
      Test: "Run the tests and fix any failures.",
      Commit: "Commit this work.",
      Review: "Review your diff for bugs.",
      Summary: "Summarize where things stand and what's left.",
    };
    const stored = {
      radialMenu: {
        enabled: true,
        slots: DEFAULT_RADIAL_SLOTS.map((slot) => {
          if (slot.label === "Review") return { ...slot, text: "Look for bugs." };
          const text = old[slot.label];
          return text === undefined ? { ...slot } : { ...slot, text };
        }),
      },
    };
    const texts = Object.fromEntries(
      SettingsSchema.parse(migrateSettings(stored, 11)).radialMenu.slots.map((slot) => [
        slot.label,
        slot.text,
      ]),
    );
    expect(texts.Test).toBe("Run the tests and fix any failures");
    expect(texts.Commit).toBe("Commit this work");
    expect(texts.Summary).toBe("Summarize where things stand and what's left");
    expect(texts.Review).toBe("Look for bugs.");
  });

  it("gives version 12 settings the default target fallback and keeps everything else", () => {
    const stored = {
      agents: { includeSubagents: true },
      radialMenu: { enabled: false },
      pins: ["w1", null, null, null, null, null],
    };
    const migrated = migrateSettings(stored, 12);
    expect(migrated).toEqual({ ...stored, topKeys: { mode: "navigation" } });
    const settings = SettingsSchema.parse(migrated);
    expect(settings.targets.fallback).toBe("nextActionable");
    expect(settings.agents.includeSubagents).toBe(true);
    expect(settings.radialMenu.enabled).toBe(false);
    expect(SettingsSchema.parse({ targets: { fallback: "none" } }).targets.fallback).toBe("none");
    expect(SettingsSchema.safeParse({ targets: { fallback: "anyAgent" } }).success).toBe(false);
  });

  /** Settings as version 13 stored them by default: every binding and slot at its default. */
  const VERSION_13_STORED = () => ({
    bindings: {
      ...structuredClone(DEFAULT_SETTINGS.bindings),
      ACT07: { action: "navigateBack", text: "" },
      ACT08: { action: "previousWorkspace", text: "" },
      ACT09: { action: "nextWorkspace", text: "" },
    },
    radialMenu: {
      enabled: true,
      slots: DEFAULT_SETTINGS.radialMenu.slots.map((slot, index) =>
        index === 0
          ? {
              icon: "checkmark.circle",
              label: "Approve",
              color: "#34C759",
              action: "approvePermission",
              text: "",
            }
          : index === 4
            ? {
                icon: "xmark.circle",
                label: "Deny",
                color: "#FF3B30",
                action: "denyPermission",
                text: "",
              }
            : { ...slot },
      ),
    },
    pins: ["w1", null, null, null, null, null],
  });

  it("moves version 13 settings at their defaults to the ChatGPT layout", () => {
    const settings = SettingsSchema.parse(migrateSettings(VERSION_13_STORED(), 13));
    expect(settings.topKeys).toEqual({ mode: "navigation", openOnSingleTap: false });
    expect(settings.bindings).toEqual(DEFAULT_SETTINGS.bindings);
    expect(
      [settings.bindings.ACT07, settings.bindings.ACT08, settings.bindings.ACT09].map(
        (binding) => binding.action,
      ),
    ).toEqual(["approvePermission", "denyPermission", "newAgent"]);
    expect(settings.radialMenu).toEqual(DEFAULT_SETTINGS.radialMenu);
    expect(settings.pins[0]).toBe("w1");
    expect(SettingsSchema.parse(migrateSettings({}, 13))).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the version 13 bindings and radial slots that the user changed", () => {
    const stored = VERSION_13_STORED();
    stored.bindings.ACT07 = { action: "stopAgent", text: "" };
    stored.bindings.ACT09 = { action: "sendPrompt", text: "Continue" };
    const slots = stored.radialMenu.slots as Record<string, unknown>[];
    slots[0] = { ...slots[0], color: "#0A84FF" };
    const settings = SettingsSchema.parse(migrateSettings(stored, 13));
    expect(settings.bindings.ACT07.action).toBe("stopAgent");
    expect(settings.bindings.ACT08.action).toBe("denyPermission");
    expect(settings.bindings.ACT09).toEqual({ action: "sendPrompt", text: "Continue" });
    expect(settings.radialMenu.slots[0]).toMatchObject({
      label: "Approve",
      color: "#0A84FF",
      action: "approvePermission",
    });
    expect(settings.radialMenu.slots[4]).toMatchObject({
      icon: "arrow.uturn.forward.circle",
      label: "Forward",
      action: "navigateForward",
    });
  });

  it("sets the top keys to navigation from version 13, whatever was stored", () => {
    const settings = SettingsSchema.parse(
      migrateSettings({ topKeys: { mode: "workspaces", openOnSingleTap: true } }, 13),
    );
    expect(settings.topKeys).toEqual({ mode: "navigation", openOnSingleTap: true });
    const current = SettingsSchema.parse({ topKeys: { mode: "pinned" } });
    expect(current.topKeys.mode).toBe("pinned");
    expect(SettingsSchema.safeParse({ topKeys: { mode: "threads" } }).success).toBe(false);
  });

  it("defaults the top keys to navigation and their light to dim white", () => {
    expect(DEFAULT_SETTINGS.topKeys).toEqual({ mode: "navigation", openOnSingleTap: false });
    expect(DEFAULT_SETTINGS.lights.navigation).toEqual({
      color: "#FFFFFF",
      effect: "solid",
      brightness: 0.15,
      speed: 0.5,
    });
  });
});
