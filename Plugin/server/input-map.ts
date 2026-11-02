import type { ActionId } from "../shared/actions";
import { groupLeader, groupOf } from "../shared/key-groups";
import {
  JOYSTICK_KEYS,
  WORKSPACE_KEY_COUNT,
  keyActionInput,
  type ActionInput,
  type JoystickDirection,
} from "../shared/keypad";
import { RADIAL_SLOT_NAMES } from "../shared/radial-menu";
import type { Binding, KeypadSettings } from "../shared/settings";
import type { BridgeInput, JoystickInput, KeyInput } from "./bridge-protocol";

export type { JoystickDirection } from "../shared/keypad";

/** How an input happened: a press, a release, or a step with no release (dial turn, joystick push). */
export type InputPhase = "press" | "release" | "step";

export type ResolvedInput =
  | { kind: "workspaceKey"; slot: number; phase: "press" | "release" }
  | { kind: "action"; input: ActionInput; phase: InputPhase }
  /** The joystick picked a slot of the radial menu, 0 (up) to 7, clockwise. */
  | { kind: "radialSlot"; slot: number };

/** A push counts once the stick is this far from the center. */
export const JOYSTICK_PUSH_DISTANCE = 0.6;
/** The stick is back at rest below this distance, or when the sector is -1. */
export const JOYSTICK_REST_DISTANCE = 0.1;

/** The direction of a joystick angle: 0..1, counterclockwise from east. */
export function joystickDirection(angle: number): JoystickDirection {
  const turn = ((angle % 1) + 1) % 1;
  const quadrant = Math.floor(((turn + 0.125) % 1) * 4);
  return (
    (["joystickRight", "joystickUp", "joystickLeft", "joystickDown"] as const)[quadrant] ??
    "joystickRight"
  );
}

/**
 * Turns bridge inputs into workspace-key presses and action inputs.
 *
 * The dial has three gestures. A turn while the dial is up is `dialClockwise` or
 * `dialCounterclockwise`; a turn while it is held down is `dialHeldClockwise` or
 * `dialHeldCounterclockwise`; and a click, a press and release with no turn between them,
 * is `dialPress`, which happens on the release. All three are steps, with no release.
 *
 * The joystick counts one push for each deflection: it fires when the stick enters a direction
 * past `JOYSTICK_PUSH_DISTANCE`, and nothing more until the stick returns to rest.
 * It reads directions from the angle, not from the sector numbers.
 * A keymap can instead bind the joystick's cardinal sectors to `AG15`–`AG18`
 * (`JOYSTICK_KEYS`); a press of one of them is a push, and the joystick rests
 * once all of them are released.
 * Firmware 0.6.3 sends both for one deflection, the radial positions first,
 * so once a radial position arrives, the sector keys are ignored
 * and each deflection is one push.
 */
export class InputMapper {
  private joystickArmed = true;
  private readonly joystickKeys = new Set<number>();
  private radialSeen = false;
  private dialHeld = false;
  private dialTurned = false;

  /** Forgets the joystick's position and the held dial, as after a lost connection. */
  reset(): void {
    this.joystickArmed = true;
    this.joystickKeys.clear();
    this.radialSeen = false;
    this.dialHeld = false;
    this.dialTurned = false;
  }

  resolve(input: BridgeInput): ResolvedInput | null {
    switch (input.kind) {
      case "key": {
        if (input.key < WORKSPACE_KEY_COUNT) {
          return { kind: "workspaceKey", slot: input.key, phase: input.action };
        }
        if (JOYSTICK_KEYS[input.key] !== undefined) return this.resolveJoystickKey(input);
        const actionInput = keyActionInput(input.key);
        return actionInput ? { kind: "action", input: actionInput, phase: input.action } : null;
      }
      case "dial":
        switch (input.action) {
          case "clockwise":
          case "counterclockwise": {
            const clockwise = input.action === "clockwise";
            if (this.dialHeld) {
              this.dialTurned = true;
              const held = clockwise ? "dialHeldClockwise" : "dialHeldCounterclockwise";
              return { kind: "action", input: held, phase: "step" };
            }
            const turn = clockwise ? "dialClockwise" : "dialCounterclockwise";
            return { kind: "action", input: turn, phase: "step" };
          }
          case "press":
            this.dialHeld = true;
            this.dialTurned = false;
            return null;
          case "release": {
            const click = this.dialHeld && !this.dialTurned;
            this.dialHeld = false;
            this.dialTurned = false;
            return click ? { kind: "action", input: "dialPress", phase: "step" } : null;
          }
        }
        return null;
      case "joystick":
        return this.resolveJoystick(input);
      case "radial":
        return { kind: "radialSlot", slot: input.slot };
    }
  }

  private resolveJoystick(input: JoystickInput): ResolvedInput | null {
    this.radialSeen = true;
    if (input.sector === -1 || input.distance < JOYSTICK_REST_DISTANCE) {
      this.joystickArmed = true;
      return null;
    }
    if (!this.joystickArmed || input.distance < JOYSTICK_PUSH_DISTANCE) return null;
    this.joystickArmed = false;
    return { kind: "action", input: joystickDirection(input.angle), phase: "step" };
  }

  /** A sector key: the first press of a deflection fires; the stick rests when all are up. */
  private resolveJoystickKey(input: KeyInput): ResolvedInput | null {
    if (this.radialSeen) return null;
    const direction = JOYSTICK_KEYS[input.key];
    if (input.action === "release") {
      this.joystickKeys.delete(input.key);
      return null;
    }
    const resting = this.joystickKeys.size === 0;
    this.joystickKeys.add(input.key);
    if (!resting || direction === undefined) return null;
    return { kind: "action", input: direction, phase: "step" };
  }
}

/**
 * An input that is held down: the binding it had when pressed, and whether its action started.
 * The keys of one keycap share one gesture.
 */
export interface Gesture {
  readonly binding: Binding;
  /** Set by push to talk once its press has started dictation. */
  started: boolean;
}

/**
 * The action inputs that are held down, each with its gesture.
 * A press while the input is already held, and a release without a press,
 * belong to no gesture; for example, a release that arrives after a reconnect.
 *
 * The inputs of a group, such as two keys under one keycap, share a gesture:
 * it starts with the first press of any of them and ends when the last held one is released,
 * so that a press that closes one switch or both starts and ends the action once.
 */
export class HeldInputs {
  private readonly held = new Map<ActionInput, Gesture>();

  /**
   * Starts a gesture, or returns null when the input is already held
   * or joins a gesture that another input of its group holds.
   * `group` is the input's group, including the input; by default the input alone.
   */
  press(
    input: ActionInput,
    binding: Binding,
    group: readonly ActionInput[] = [input],
  ): Gesture | null {
    if (this.held.has(input)) return null;
    for (const member of group) {
      const shared = this.held.get(member);
      if (shared) {
        this.held.set(input, shared);
        return null;
      }
    }
    const gesture: Gesture = { binding, started: false };
    this.held.set(input, gesture);
    return gesture;
  }

  /**
   * Releases an input. Returns its gesture when that was the last input holding it,
   * or null when another input still holds it or the input is not held.
   */
  release(input: ActionInput): Gesture | null {
    const gesture = this.held.get(input);
    if (!gesture) return null;
    this.held.delete(input);
    for (const other of this.held.values()) if (other === gesture) return null;
    return gesture;
  }

  /** Forgets every held input, as after a lost connection. */
  reset(): void {
    this.held.clear();
  }
}

/** What an action does for one phase of its input. */
export type ActionTrigger =
  | { kind: "run"; action: Exclude<ActionId, "none" | "pushToTalk">; text: string }
  | { kind: "talk"; mode: "start" | "stop" | "toggle" }
  | { kind: "ignore" };

/**
 * Decides whether a bound action runs for an input phase.
 * Push to talk starts on press, stops on release, and toggles on a step.
 * Every other action runs on press or step and ignores the release.
 */
export function triggerFor(binding: Binding, phase: InputPhase): ActionTrigger {
  if (binding.action === "none") return { kind: "ignore" };
  if (binding.action === "pushToTalk") {
    const mode = phase === "press" ? "start" : phase === "release" ? "stop" : "toggle";
    return { kind: "talk", mode };
  }
  if (phase === "release") return { kind: "ignore" };
  return { kind: "run", action: binding.action, text: binding.text };
}

/** The binding of an input: its group's first key's binding for a key under a shared keycap. */
export function bindingFor(settings: KeypadSettings, input: ActionInput): Binding {
  return settings.bindings[groupLeader(settings.keyGroups, input)];
}

/** The inputs that share a gesture with an input, including the input. */
export function gestureGroup(settings: KeypadSettings, input: ActionInput): readonly ActionInput[] {
  return groupOf(settings.keyGroups, input);
}

/** A short description of an input, for logs and the status screen. */
export function describeInput(input: BridgeInput): string {
  switch (input.kind) {
    case "key": {
      const direction = JOYSTICK_KEYS[input.key];
      const name = input.code ?? `key ${input.key}`;
      return direction
        ? `${name} (joystick ${direction.slice("joystick".length).toLowerCase()}) ${input.action}`
        : `${name} ${input.action}`;
    }
    case "dial":
      return `dial ${input.action}`;
    case "radial":
      return `radial menu ${RADIAL_SLOT_NAMES[input.slot]?.toLowerCase() ?? `slot ${input.slot}`}`;
    case "joystick":
      return input.sector === -1
        ? "joystick at rest"
        : `joystick ${joystickDirection(input.angle).slice("joystick".length).toLowerCase()} (${input.distance.toFixed(2)})`;
  }
}
