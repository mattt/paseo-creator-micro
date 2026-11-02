import { describe, expect, it } from "vite-plus/test";
import {
  bindingFor,
  describeInput,
  gestureGroup,
  HeldInputs,
  InputMapper,
  joystickDirection,
  triggerFor,
} from "../server/input-map";
import { ACTION_INPUTS } from "../shared/keypad";
import { DEFAULT_SETTINGS, SettingsSchema } from "../shared/settings";

describe("InputMapper", () => {
  it("maps keys 0–5 to workspace keys", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "key", key: 0, code: "AG00", action: "press" })).toEqual({
      kind: "workspaceKey",
      slot: 0,
      phase: "press",
    });
    expect(mapper.resolve({ kind: "key", key: 5, action: "release" })).toEqual({
      kind: "workspaceKey",
      slot: 5,
      phase: "release",
    });
  });

  it("maps keys 6–12 to their action inputs", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "key", key: 6, action: "press" })).toEqual({
      kind: "action",
      input: "ACT06",
      phase: "press",
    });
    expect(mapper.resolve({ kind: "key", key: 12, action: "release" })).toEqual({
      kind: "action",
      input: "ACT12",
      phase: "release",
    });
  });

  it("maps keys 6–12 sent as AG06–AG12, on a layer that lights them, to the same action inputs", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "key", key: 6, code: "AG06", action: "press" })).toEqual({
      kind: "action",
      input: "ACT06",
      phase: "press",
    });
    expect(mapper.resolve({ kind: "key", key: 12, code: "AG12", action: "release" })).toEqual({
      kind: "action",
      input: "ACT12",
      phase: "release",
    });
    expect(describeInput({ kind: "key", key: 6, code: "AG06", action: "press" })).toBe(
      "AG06 press",
    );
  });

  it("maps dial turns by direction", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "dial", action: "clockwise" })).toEqual({
      kind: "action",
      input: "dialClockwise",
      phase: "step",
    });
    expect(mapper.resolve({ kind: "dial", action: "counterclockwise" })).toEqual({
      kind: "action",
      input: "dialCounterclockwise",
      phase: "step",
    });
  });

  it("makes a press and release with no turn between them a click, on the release", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "dial", action: "press" })).toBeNull();
    expect(mapper.resolve({ kind: "dial", action: "release" })).toEqual({
      kind: "action",
      input: "dialPress",
      phase: "step",
    });
  });

  it("maps turns while the dial is held to the held inputs, and then no click", () => {
    const mapper = new InputMapper();
    mapper.resolve({ kind: "dial", action: "press" });
    expect(mapper.resolve({ kind: "dial", action: "clockwise" })).toEqual({
      kind: "action",
      input: "dialHeldClockwise",
      phase: "step",
    });
    expect(mapper.resolve({ kind: "dial", action: "counterclockwise" })).toMatchObject({
      input: "dialHeldCounterclockwise",
    });
    expect(mapper.resolve({ kind: "dial", action: "release" })).toBeNull();
    expect(mapper.resolve({ kind: "dial", action: "clockwise" })).toMatchObject({
      input: "dialClockwise",
    });
  });

  it("ignores a dial release without its press, and forgets a held dial on reset", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "dial", action: "release" })).toBeNull();
    mapper.resolve({ kind: "dial", action: "press" });
    mapper.reset();
    expect(mapper.resolve({ kind: "dial", action: "clockwise" })).toMatchObject({
      input: "dialClockwise",
    });
    expect(mapper.resolve({ kind: "dial", action: "release" })).toBeNull();
  });

  it("reads the directions of the layer 1 capture of 2026-10-26 from the angle", () => {
    const captures = [
      [0.25, 0, "joystickUp"],
      [0.46, 2, "joystickLeft"],
      [0.75, 4, "joystickDown"],
      [0.0, 6, "joystickRight"],
    ] as const;
    for (const [angle, sector, input] of captures) {
      const mapper = new InputMapper();
      expect(mapper.resolve({ kind: "joystick", angle, distance: 1, sector })).toMatchObject({
        input,
      });
    }
  });

  it("maps the joystick sector keys AG15–AG18 to down, left, up, and right", () => {
    // The firmware counts angles clockwise, so its sector at 0.25 is a push down
    // (checked on the keypad on 2026-10-28).
    const directions = [
      [15, "joystickDown"],
      [16, "joystickLeft"],
      [17, "joystickUp"],
      [18, "joystickRight"],
    ] as const;
    for (const [key, input] of directions) {
      const mapper = new InputMapper();
      expect(mapper.resolve({ kind: "key", key, code: `AG${key}`, action: "press" })).toEqual({
        kind: "action",
        input,
        phase: "step",
      });
      expect(mapper.resolve({ kind: "key", key, action: "release" })).toBeNull();
    }
  });

  it("pushes once when a deflection sends radial positions and then its sector key", () => {
    // Recorded on firmware 0.6.3, layer 2, on 2026-10-28: a push up (firmware angle 0.755),
    // which the app reports mirrored, as 0.245, followed by its sector key AG17.
    const mapper = new InputMapper();
    const radial = (angle: number, distance: number, sector: number) =>
      mapper.resolve({ kind: "joystick", angle, distance, sector });
    const key = (action: "press" | "release") => mapper.resolve({ kind: "key", key: 17, action });
    expect(radial(0.24487, 1, 4)).toMatchObject({ input: "joystickUp" });
    expect(radial(0.242567, 0.611383, 4)).toBeNull();
    expect(key("press")).toBeNull();
    expect(key("release")).toBeNull();
    expect(radial(0.12942, 0, -1)).toBeNull();
    expect(radial(0.505877, 0.944468, 2)).toMatchObject({ input: "joystickLeft" });
    expect(mapper.resolve({ kind: "key", key: 16, action: "press" })).toBeNull();
  });

  it("uses the sector keys again after a reset, until a radial position arrives", () => {
    const mapper = new InputMapper();
    mapper.resolve({ kind: "joystick", angle: 0.25, distance: 1, sector: 0 });
    mapper.reset();
    expect(mapper.resolve({ kind: "key", key: 15, action: "press" })).toMatchObject({
      input: "joystickDown",
    });
  });

  it("fires a sector key once for each deflection, until every sector key is released", () => {
    const mapper = new InputMapper();
    const key = (key: number, action: "press" | "release") =>
      mapper.resolve({ kind: "key", key, action });
    expect(key(15, "press")).toMatchObject({ input: "joystickDown" });
    expect(key(15, "press")).toBeNull();
    expect(key(16, "press")).toBeNull();
    expect(key(15, "release")).toBeNull();
    expect(key(16, "release")).toBeNull();
    expect(key(17, "press")).toMatchObject({ input: "joystickUp" });
    mapper.reset();
    expect(key(18, "press")).toMatchObject({ input: "joystickRight" });
  });

  it("ignores the other unlit keys", () => {
    const mapper = new InputMapper();
    for (const key of [13, 14, 19]) {
      expect(mapper.resolve({ kind: "key", key, action: "press" })).toBeNull();
    }
  });

  it("counts one joystick push until the stick returns to rest", () => {
    const mapper = new InputMapper();
    const up = { kind: "joystick", angle: 0.25, distance: 1, sector: 2 } as const;
    expect(mapper.resolve(up)).toEqual({ kind: "action", input: "joystickUp", phase: "step" });
    expect(mapper.resolve(up)).toBeNull();
    expect(mapper.resolve({ ...up, angle: 0.5 })).toBeNull();
    expect(mapper.resolve({ kind: "joystick", angle: 0, distance: 0, sector: -1 })).toBeNull();
    expect(mapper.resolve({ ...up, angle: 0.5 })).toMatchObject({ input: "joystickLeft" });
  });

  it("ignores small joystick movements and rearms only near the center", () => {
    const mapper = new InputMapper();
    expect(mapper.resolve({ kind: "joystick", angle: 0.75, distance: 0.4, sector: 6 })).toBeNull();
    expect(
      mapper.resolve({ kind: "joystick", angle: 0.75, distance: 0.9, sector: 6 }),
    ).toMatchObject({ input: "joystickDown" });
    expect(mapper.resolve({ kind: "joystick", angle: 0.75, distance: 0.2, sector: 6 })).toBeNull();
    expect(mapper.resolve({ kind: "joystick", angle: 0, distance: 0.7, sector: 0 })).toBeNull();
    expect(mapper.resolve({ kind: "joystick", angle: 0, distance: 0.05, sector: 0 })).toBeNull();
    expect(mapper.resolve({ kind: "joystick", angle: 0, distance: 0.7, sector: 0 })).toMatchObject({
      input: "joystickRight",
    });
  });
});

describe("HeldInputs", () => {
  const talk = { action: "pushToTalk", text: "" } as const;

  it("pairs a release with its press and keeps the press-time binding", () => {
    const held = new HeldInputs();
    const gesture = held.press("ACT10", talk);
    expect(gesture).toEqual({ binding: talk, started: false });
    expect(held.release("ACT10")).toBe(gesture);
    expect(held.release("ACT10")).toBeNull();
  });

  it("ignores a second press and a release without a press", () => {
    const held = new HeldInputs();
    expect(held.release("ACT10")).toBeNull();
    expect(held.press("ACT10", talk)).not.toBeNull();
    expect(held.press("ACT10", talk)).toBeNull();
  });

  it("forgets held inputs on reset", () => {
    const held = new HeldInputs();
    held.press("ACT10", talk);
    held.reset();
    expect(held.release("ACT10")).toBeNull();
  });

  describe("with two keys under one keycap", () => {
    const keycap = ["ACT10", "ACT11"] as const;

    it.each(keycap)("starts and ends one gesture when only %s closes", (input) => {
      const held = new HeldInputs();
      const gesture = held.press(input, talk, keycap);
      expect(gesture).not.toBeNull();
      expect(held.release(input)).toBe(gesture);
    });

    it.each([
      ["the first key", "ACT10", "ACT11"],
      ["the second key", "ACT11", "ACT10"],
    ] as const)(
      "starts once when both close and ends when %s is released last",
      (_name, firstUp, lastUp) => {
        const held = new HeldInputs();
        const gesture = held.press("ACT10", talk, keycap);
        expect(held.press("ACT11", talk, keycap)).toBeNull();
        expect(held.release(firstUp)).toBeNull();
        expect(held.release(lastUp)).toBe(gesture);
        expect(held.release(lastUp)).toBeNull();
      },
    );

    it("keeps the gesture while the keys close and open in turn", () => {
      const held = new HeldInputs();
      const gesture = held.press("ACT11", talk, keycap);
      expect(held.press("ACT10", talk, keycap)).toBeNull();
      expect(held.release("ACT11")).toBeNull();
      expect(held.press("ACT11", talk, keycap)).toBeNull();
      expect(held.release("ACT10")).toBeNull();
      expect(held.release("ACT11")).toBe(gesture);
    });

    it("keeps keys that are not in the group apart", () => {
      const held = new HeldInputs();
      const talking = held.press("ACT10", talk, keycap);
      const other = held.press("ACT12", talk);
      expect(other).not.toBeNull();
      expect(other).not.toBe(talking);
      expect(held.release("ACT12")).toBe(other);
      expect(held.release("ACT10")).toBe(talking);
    });
  });
});

describe("joystickDirection", () => {
  it("divides the circle into four directions, counterclockwise from east", () => {
    expect(joystickDirection(0)).toBe("joystickRight");
    expect(joystickDirection(0.12)).toBe("joystickRight");
    expect(joystickDirection(0.13)).toBe("joystickUp");
    expect(joystickDirection(0.24)).toBe("joystickUp");
    expect(joystickDirection(0.5)).toBe("joystickLeft");
    expect(joystickDirection(0.75)).toBe("joystickDown");
    expect(joystickDirection(0.9)).toBe("joystickRight");
    expect(joystickDirection(1)).toBe("joystickRight");
    expect(joystickDirection(-0.25)).toBe("joystickDown");
  });
});

describe("triggerFor", () => {
  it("starts push to talk on press, stops it on release, and toggles it on a step", () => {
    const binding = { action: "pushToTalk", text: "" } as const;
    expect(triggerFor(binding, "press")).toEqual({ kind: "talk", mode: "start" });
    expect(triggerFor(binding, "release")).toEqual({ kind: "talk", mode: "stop" });
    expect(triggerFor(binding, "step")).toEqual({ kind: "talk", mode: "toggle" });
  });

  it("runs other actions on press or step and ignores the release", () => {
    const binding = { action: "nextActionableAgent", text: "" } as const;
    expect(triggerFor(binding, "press")).toEqual({
      kind: "run",
      action: "nextActionableAgent",
      text: "",
    });
    expect(triggerFor(binding, "step")).toMatchObject({ kind: "run" });
    expect(triggerFor(binding, "release")).toEqual({ kind: "ignore" });
  });

  it("ignores inputs bound to nothing", () => {
    expect(triggerFor({ action: "none", text: "" }, "press")).toEqual({ kind: "ignore" });
  });

  it("carries the prompt text of a send-prompt binding", () => {
    expect(triggerFor({ action: "sendPrompt", text: "Continue." }, "press")).toEqual({
      kind: "run",
      action: "sendPrompt",
      text: "Continue.",
    });
  });
});

describe("bindings", () => {
  it("has a default for every input", () => {
    for (const input of ACTION_INPUTS)
      expect(bindingFor(DEFAULT_SETTINGS, input).action).toBeTruthy();
    const actions = ACTION_INPUTS.slice(0, 7).map((input) => bindingFor(DEFAULT_SETTINGS, input));
    expect(actions.map((binding) => binding.action)).toEqual([
      "nextActionableAgent",
      "approvePermission",
      "denyPermission",
      "newAgent",
      "pushToTalk",
      "pushToTalk",
      "submit",
    ]);
    expect(bindingFor(DEFAULT_SETTINGS, "dialClockwise").action).toBe("scrollDown");
    expect(bindingFor(DEFAULT_SETTINGS, "dialCounterclockwise").action).toBe("scrollUp");
    expect(bindingFor(DEFAULT_SETTINGS, "dialPress").action).toBe("jumpToBottom");
    expect(bindingFor(DEFAULT_SETTINGS, "dialHeldClockwise").action).toBe("scrollDownFast");
    expect(bindingFor(DEFAULT_SETTINGS, "dialHeldCounterclockwise").action).toBe("scrollUpFast");
    for (const input of ["joystickUp", "joystickDown", "joystickLeft", "joystickRight"] as const) {
      expect(bindingFor(DEFAULT_SETTINGS, input)).toEqual({ action: "sendPrompt", text: "" });
    }
  });

  it("binds nothing on the dial that interrupts an agent or changes its thinking", () => {
    const dial = ACTION_INPUTS.filter((input) => input.startsWith("dial"));
    for (const input of dial) {
      expect(["stopAgent", "denyPermission", "thinkingUp", "thinkingDown"]).not.toContain(
        bindingFor(DEFAULT_SETTINGS, input).action,
      );
    }
  });

  it("binds no input to voice mode by default", () => {
    for (const input of ACTION_INPUTS) {
      expect(bindingFor(DEFAULT_SETTINGS, input).action).not.toBe("toggleVoiceMode");
    }
  });

  it("puts keys 11 and 12 under one keycap with key 11's binding", () => {
    expect(DEFAULT_SETTINGS.keyGroups).toEqual([["ACT10", "ACT11"]]);
    expect(gestureGroup(DEFAULT_SETTINGS, "ACT11")).toEqual(["ACT10", "ACT11"]);
    expect(gestureGroup(DEFAULT_SETTINGS, "ACT12")).toEqual(["ACT12"]);
    const settings = SettingsSchema.parse({ bindings: { ACT11: { action: "stopAgent" } } });
    expect(bindingFor(settings, "ACT11").action).toBe("pushToTalk");
    const apart = SettingsSchema.parse({
      keyGroups: [],
      bindings: { ACT11: { action: "stopAgent" } },
    });
    expect(bindingFor(apart, "ACT11").action).toBe("stopAgent");
    expect(gestureGroup(apart, "ACT11")).toEqual(["ACT11"]);
  });

  it("uses a configured binding and keeps defaults for the rest", () => {
    const settings = SettingsSchema.parse({ bindings: { ACT06: { action: "stopAgent" } } });
    expect(bindingFor(settings, "ACT06")).toEqual({ action: "stopAgent", text: "" });
    expect(bindingFor(settings, "ACT07").action).toBe("approvePermission");
  });
});

describe("describeInput", () => {
  it("names inputs for the status screen", () => {
    expect(describeInput({ kind: "key", key: 3, code: "AG03", action: "press" })).toBe(
      "AG03 press",
    );
    expect(describeInput({ kind: "dial", action: "clockwise" })).toBe("dial clockwise");
    expect(describeInput({ kind: "joystick", angle: 0.5, distance: 1, sector: 4 })).toBe(
      "joystick left (1.00)",
    );
    expect(describeInput({ kind: "key", key: 16, code: "AG16", action: "press" })).toBe(
      "AG16 (joystick left) press",
    );
  });
});
