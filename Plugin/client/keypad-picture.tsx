import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { ACTIONS } from "../shared/actions";
import { groupLeader, groupOf } from "../shared/key-groups";
import {
  ACTION_INPUT_LABELS,
  JOYSTICK_DIRECTIONS,
  keyActionInput,
  keyName,
  type ActionInput,
  type ActionKey,
} from "../shared/keypad";
import type { KeyLight, KeypadStatus } from "../shared/rpc";
import type { KeypadSettings } from "../shared/settings";
import { joystickDetail, keycapLabel, topKeyLabel } from "./summary";

/** An input chosen in the picture: a top key (keys 0–5), an action key, the dial, or the joystick. */
export type PictureSelection =
  | { kind: "workspaceKey"; key: number }
  | { kind: "input"; input: ActionKey }
  | { kind: "dial" }
  | { kind: "joystick" };

interface KeypadPictureProps {
  theme: PluginTheme;
  settings: KeypadSettings;
  status: KeypadStatus | undefined;
  selection: PictureSelection;
  onSelect: (selection: PictureSelection) => void;
}

// The keypad's measurements, in points, in the proportions of the menu bar app's drawing.
const KEY = 72;
const GAP = 8;
const PLATE_PADDING = 18;
const BEZEL = 14;
const GRID = KEY * 4 + GAP * 3;
const PLATE = GRID + PLATE_PADDING * 2;
const BODY = PLATE + BEZEL * 2;
const BODY_CORNER = 40;
const PLATE_CORNER = BODY_CORNER - BEZEL;
const CAP_CORNER = 11;

/** The key with a frosted, translucent keycap, which shows its light through the whole cap. */
const FROSTED_KEY = 6;

/** The keypad's cells, by row: the knob and joystick share the top row with keys 0 and 1. */
type Cell =
  | { kind: "knob" }
  | { kind: "joystick" }
  | { kind: "badge" }
  | { kind: "keys"; keys: number[] };

const ROWS: readonly (readonly (Cell | number)[])[] = [
  [{ kind: "knob" }, 0, 1, { kind: "joystick" }],
  [2, 3, 4, 5],
  [6, 7, 8, 9],
  [{ kind: "badge" }, 10, 11, 12],
];

/** Splits a row into cells, with the keys under one keycap in one cell. */
function cells(row: readonly (Cell | number)[], settings: KeypadSettings): Cell[] {
  const result: Cell[] = [];
  for (const item of row) {
    if (typeof item !== "number") {
      result.push(item);
      continue;
    }
    const last = result.at(-1);
    const previous = last?.kind === "keys" ? last.keys.at(-1) : undefined;
    const input = keyActionInput(item);
    const before = previous === undefined ? null : keyActionInput(previous);
    if (
      last?.kind === "keys" &&
      input &&
      before &&
      groupOf(settings.keyGroups, before).includes(input)
    ) {
      last.keys.push(item);
    } else {
      result.push({ kind: "keys", keys: [item] });
    }
  }
  return result;
}

/** A light as it looks: its color and how strongly it shows, or null when it is dark. */
function appearance(
  light: KeyLight | null | undefined,
): { color: string; strength: number } | null {
  if (!light || light.effect === "off" || light.brightness <= 0) return null;
  if (/^#0{6}$/.test(light.color)) return null;
  return { color: light.color, strength: 0.45 + 0.55 * Math.min(1, light.brightness * 2) };
}

/** A hex color with an opacity from 0 to 1. */
function alpha(color: string, opacity: number): string {
  const value = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return `${color.slice(0, 7)}${value.toString(16).padStart(2, "0")}`;
}

const GRAY = {
  body: "#1c1c1f",
  plate: "#0d0d0f",
  cap: "#2f2f33",
  dish: "#27272b",
  knob: "#1a1a1d",
  metal: "#8b8b92",
  ring: "#3a3a40",
} as const;

/**
 * A drawing of the Creator Micro 2 from above, after the menu bar app's drawing:
 * the knob and the joystick beside keys 1 and 2, the keys in rows below them,
 * keys under one keycap as one wide key, and the light ring around the plate.
 * Each key shows what it does and its current light; the light ring shows the underglow.
 * The knob and the joystick select the dial's and the joystick's settings.
 */
export function KeypadPicture({
  theme,
  settings,
  status,
  selection,
  onSelect,
}: KeypadPictureProps) {
  const ring = appearance(status?.ambient);
  const connected = status?.bridge.state === "connected" && status.keypad?.connected === true;
  const styles = useMemo(() => pictureStyles(), []);

  const isSelected = (cell: Cell): boolean => {
    switch (cell.kind) {
      case "knob":
        return selection.kind === "dial";
      case "joystick":
        return selection.kind === "joystick";
      case "badge":
        return false;
      case "keys": {
        const first = cell.keys[0] ?? -1;
        if (selection.kind === "workspaceKey") return selection.key === first;
        if (selection.kind !== "input") return false;
        return cell.keys.some((key) => keyActionInput(key) === selection.input);
      }
    }
  };

  /** A ring in the accent color around the chosen part. */
  const outline = (selected: boolean, radius: number) =>
    selected ? (
      <View
        pointerEvents="none"
        style={[styles.outline, { borderRadius: radius + 4, borderColor: theme.colors.accent }]}
      />
    ) : null;

  function keycap(keys: number[], selected: boolean) {
    const first = keys[0] ?? 0;
    const width = KEY * keys.length + GAP * (keys.length - 1);
    const input = keyActionInput(first);
    let title: string;
    let description: string;
    let light: KeyLight | null | undefined;
    let onPress: () => void;
    if (input === null) {
      const info = status?.keys[first];
      const mode = status?.topKeyMode ?? settings.topKeys.mode;
      title = mode === "off" ? "" : topKeyLabel(mode, first, info);
      if (mode === "navigation") {
        const action = info?.action ?? null;
        title = action ? keycapLabel(action) : title;
      }
      description = `${keyName(first)}: ${topKeyLabel(mode, first, info)}${info?.pinned ? ", pinned" : ""}`;
      light = info?.light;
      onPress = () => onSelect({ kind: "workspaceKey", key: first });
    } else {
      const leader = groupLeader(settings.keyGroups, input) as ActionKey;
      const binding = settings.bindings[leader];
      title =
        binding.action === "sendPrompt" && binding.text.trim() !== ""
          ? binding.text.trim()
          : keycapLabel(binding.action);
      description = `${keyName(...keys)}: ${ACTIONS[binding.action].label}`;
      light =
        status?.actionKeys.find((entry) => keys.includes(entry.key))?.light ??
        (status ? settings.lights.keysZone : null);
      onPress = () => onSelect({ kind: "input", input: leader });
    }
    const lit = connected ? appearance(light) : null;
    const frosted = first === FROSTED_KEY;
    const face: ViewStyle = frosted
      ? {
          backgroundColor: lit ? alpha(lit.color, 0.35 + 0.4 * lit.strength) : "#77777d",
          borderColor: "rgba(255,255,255,0.55)",
        }
      : {
          backgroundColor: GRAY.cap,
          borderColor: lit ? alpha(lit.color, 0.75 * lit.strength) : "rgba(255,255,255,0.08)",
        };
    const glow: ViewStyle = lit
      ? {
          shadowColor: lit.color,
          shadowOpacity: 0.9 * lit.strength,
          shadowRadius: frosted ? 10 : 6,
          shadowOffset: { width: 0, height: 0 },
        }
      : {};
    return (
      <Pressable
        key={first}
        accessibilityRole="button"
        accessibilityLabel={description}
        accessibilityState={{ selected }}
        onPress={onPress}
        style={[styles.cap, { width }, face, glow]}
      >
        <View
          pointerEvents="none"
          style={[
            styles.dish,
            frosted
              ? { backgroundColor: "rgba(255,255,255,0.12)", borderColor: "rgba(255,255,255,0.3)" }
              : null,
          ]}
        />
        <Text numberOfLines={3} style={[styles.capLabel, frosted ? styles.frostedText : null]}>
          {title}
        </Text>
        <Text style={[styles.capNumber, frosted ? styles.frostedNumber : null]}>
          {keys.map((key) => key + 1).join("–")}
        </Text>
        {outline(selected, CAP_CORNER)}
      </Pressable>
    );
  }

  function knob(selected: boolean) {
    const dial = settings.bindings;
    return (
      <Pressable
        key="knob"
        accessibilityRole="button"
        accessibilityLabel={`Dial: turn left to ${ACTIONS[dial.dialCounterclockwise.action].label}, turn right to ${ACTIONS[dial.dialClockwise.action].label}, click to ${ACTIONS[dial.dialPress.action].label}`}
        accessibilityState={{ selected }}
        onPress={() => onSelect({ kind: "dial" })}
        style={styles.part}
      >
        <View style={styles.knob}>
          <View style={styles.knobInner} />
          <View style={styles.knobBar} />
        </View>
        {outline(selected, KEY / 2)}
      </Pressable>
    );
  }

  function joystick(selected: boolean) {
    const radial = settings.radialMenu.enabled;
    return (
      <Pressable
        key="joystick"
        accessibilityRole="button"
        accessibilityLabel={
          radial ? "Joystick: radial menu" : "Joystick: a prompt for each direction"
        }
        accessibilityState={{ selected }}
        onPress={() => onSelect({ kind: "joystick" })}
        style={styles.part}
      >
        <View style={styles.stickBase}>
          <View style={styles.stickCap} />
        </View>
        {outline(selected, 12)}
      </Pressable>
    );
  }

  function badge() {
    const leds = ["#FFE06B", "#C7E6FF", "#FFE06B"];
    return (
      <View key="badge" style={[styles.part, styles.badge]} accessibilityElementsHidden>
        <View style={styles.leds}>
          {leds.map((color, index) => (
            <View
              key={index}
              style={[styles.led, { backgroundColor: connected ? color : "#3a3a3e" }]}
            />
          ))}
        </View>
        <View style={styles.badgeCircle} />
      </View>
    );
  }

  const ringStyle: ViewStyle = ring
    ? {
        borderColor: alpha(ring.color, 0.5 + 0.5 * ring.strength),
        shadowColor: ring.color,
        shadowOpacity: 0.8 * ring.strength,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
      }
    : { borderColor: GRAY.ring };
  const bodyGlow: ViewStyle =
    ring && connected
      ? {
          shadowColor: ring.color,
          shadowOpacity: 0.55 * ring.strength,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 0 },
        }
      : {
          shadowColor: "#000000",
          shadowOpacity: 0.35,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        };

  return (
    <View style={styles.wrap}>
      <View
        accessibilityLabel={connected ? "Creator Micro 2" : "Creator Micro 2, not connected"}
        style={[styles.body, bodyGlow, connected ? null : styles.dimmed]}
      >
        <View style={[styles.plate, connected ? ringStyle : { borderColor: GRAY.ring }]}>
          {[
            { top: 7, left: 7 },
            { top: 7, right: 7 },
            { bottom: 7, left: 7 },
            { bottom: 7, right: 7 },
          ].map((corner, index) => (
            <View key={index} style={[styles.screw, corner]} />
          ))}
          {ROWS.map((row, index) => (
            <View key={index} style={styles.row}>
              {cells(row, settings).map((cell) => {
                const selected = isSelected(cell);
                switch (cell.kind) {
                  case "knob":
                    return knob(selected);
                  case "joystick":
                    return joystick(selected);
                  case "badge":
                    return badge();
                  case "keys":
                    return keycap(cell.keys, selected);
                }
              })}
            </View>
          ))}
        </View>
      </View>
      <Legend theme={theme} settings={settings} selection={selection} onSelect={onSelect} />
    </View>
  );
}

/** What the dial and the joystick do, beside the picture, since their parts carry no labels. */
function Legend({
  theme,
  settings,
  selection,
  onSelect,
}: {
  theme: PluginTheme;
  settings: KeypadSettings;
  selection: PictureSelection;
  onSelect: (selection: PictureSelection) => void;
}) {
  const styles = useMemo(() => legendStyles(theme), [theme]);
  const action = (input: ActionInput) => {
    const binding = settings.bindings[input];
    return binding.action === "sendPrompt"
      ? joystickDetail(binding.action, binding.text)
      : ACTIONS[binding.action].label;
  };
  const line = (label: string, value: string) => (
    <View key={label} style={styles.line}>
      <Text style={styles.term}>{label}</Text>
      <Text style={styles.value} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
  const group = (title: string, selected: boolean, onPress: () => void, children: ReactNode) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.group, selected ? { borderColor: theme.colors.accent } : null]}
    >
      <Text style={styles.title}>{title}</Text>
      {children}
    </Pressable>
  );
  const radial = settings.radialMenu;
  return (
    <View style={styles.legend}>
      {group("Dial", selection.kind === "dial", () => onSelect({ kind: "dial" }), [
        line("Turn left", action("dialCounterclockwise")),
        line("Turn right", action("dialClockwise")),
        line("Click", action("dialPress")),
        line(
          "Hold and turn",
          `${action("dialHeldCounterclockwise")}, ${action("dialHeldClockwise")}`,
        ),
      ])}
      {group(
        "Joystick",
        selection.kind === "joystick",
        () => onSelect({ kind: "joystick" }),
        radial.enabled
          ? [
              line(
                "Radial menu",
                radial.slots
                  .filter((slot) => slot.action !== "none")
                  .map((slot) => slot.label)
                  .join(", "),
              ),
            ]
          : JOYSTICK_DIRECTIONS.map((direction) =>
              line(ACTION_INPUT_LABELS[direction].replace("Joystick ", "Push "), action(direction)),
            ),
      )}
    </View>
  );
}

function pictureStyles() {
  return {
    wrap: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "flex-start" as const,
      gap: 16,
      paddingVertical: 8,
    },
    body: {
      width: BODY,
      height: BODY,
      padding: BEZEL - 2,
      borderRadius: BODY_CORNER,
      backgroundColor: GRAY.body,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.16)",
      margin: 8,
    },
    dimmed: { opacity: 0.65 },
    plate: {
      flex: 1,
      borderRadius: PLATE_CORNER,
      borderWidth: 2,
      backgroundColor: GRAY.plate,
      padding: PLATE_PADDING - 2,
      gap: GAP,
    },
    screw: {
      position: "absolute" as const,
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: "#2a2a2e",
      borderWidth: 1,
      borderColor: "#050506",
    },
    row: { flexDirection: "row" as const, gap: GAP },
    part: {
      width: KEY,
      height: KEY,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    outline: {
      position: "absolute" as const,
      top: -4,
      left: -4,
      right: -4,
      bottom: -4,
      borderWidth: 2,
    },
    cap: {
      height: KEY,
      borderRadius: CAP_CORNER,
      borderWidth: 1,
      paddingHorizontal: 6,
      paddingTop: 6,
      paddingBottom: 4,
      justifyContent: "space-between" as const,
    },
    dish: {
      position: "absolute" as const,
      top: 5,
      left: 5,
      right: 5,
      bottom: 5,
      borderRadius: KEY * 0.3,
      backgroundColor: GRAY.dish,
      borderWidth: 1,
      borderColor: "rgba(0,0,0,0.35)",
    },
    capLabel: {
      color: "rgba(255,255,255,0.9)",
      fontSize: 10,
      lineHeight: 12,
      letterSpacing: -0.1,
      fontWeight: "500" as const,
    },
    capNumber: {
      alignSelf: "flex-end" as const,
      color: "rgba(255,255,255,0.45)",
      fontSize: 10,
      fontVariant: ["tabular-nums" as const],
    },
    frostedText: { color: "rgba(0,0,0,0.85)" },
    frostedNumber: { color: "rgba(0,0,0,0.55)" },
    knob: {
      width: KEY - 6,
      height: KEY - 6,
      borderRadius: (KEY - 6) / 2,
      backgroundColor: GRAY.knob,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.14)",
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    knobInner: {
      position: "absolute" as const,
      top: 4,
      left: 4,
      right: 4,
      bottom: 4,
      borderRadius: KEY,
      backgroundColor: "#141416",
    },
    knobBar: {
      width: 14,
      height: KEY - 14,
      borderRadius: 6,
      backgroundColor: "#3a3a3f",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.14)",
      transform: [{ rotate: "40deg" }],
    },
    stickBase: {
      width: 42,
      height: 42,
      borderRadius: 4,
      backgroundColor: GRAY.metal,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    stickCap: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: "#18181b",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.14)",
    },
    badge: { flexDirection: "row" as const, gap: 5 },
    leds: { gap: 5 },
    led: { width: 6, height: 3, borderRadius: 2 },
    badgeCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: "#18181b",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.14)",
    },
  };
}

function legendStyles(theme: PluginTheme) {
  return {
    legend: { flexGrow: 1, flexBasis: 170, gap: 12, paddingTop: 8 },
    group: {
      gap: 8,
      padding: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    line: { gap: 1 },
    term: { color: theme.colors.foregroundMuted, fontSize: 11 },
    value: { color: theme.colors.foreground, fontSize: 12 },
  };
}
