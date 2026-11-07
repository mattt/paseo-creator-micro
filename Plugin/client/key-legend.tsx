import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { ACTIONS } from "../shared/actions";
import { groupLeader, groupOf } from "../shared/key-groups";
import {
  ACTION_INPUT_LABELS,
  ACTION_KEYS,
  actionKeyIndex,
  JOYSTICK_DIRECTIONS,
  WORKSPACE_KEY_COUNT,
  type ActionInput,
  type ActionKey,
} from "../shared/keypad";
import type { KeypadStatus } from "../shared/rpc";
import type { KeypadSettings } from "../shared/settings";
import { joystickDetail, topKeyLabel } from "./summary";

/** One line of the legend: a key's number, or a part's name, and what it does. */
export interface LegendEntry {
  /** A key number, such as "7" or "11–12", or a part, such as "Dial". */
  mark: string;
  text: string;
}

/** What an input does, in words: its action, or its prompt. */
export function bindingText(settings: KeypadSettings, input: ActionInput): string {
  const binding = settings.bindings[input];
  return binding.action === "sendPrompt"
    ? joystickDetail(binding.action, binding.text)
    : ACTIONS[binding.action].label;
}

/** The keycaps of keys 7–13 in key order: one entry per keycap, led by its first key. */
export function actionKeycaps(settings: KeypadSettings): ActionKey[][] {
  const seen = new Set<ActionKey>();
  const caps: ActionKey[][] = [];
  for (const key of ACTION_KEYS) {
    if (seen.has(key)) continue;
    const group = groupOf(settings.keyGroups, key).filter((member): member is ActionKey =>
      (ACTION_KEYS as readonly string[]).includes(member),
    );
    const cap = group.length > 0 ? group : [key];
    for (const member of cap) seen.add(member);
    caps.push(cap);
  }
  return caps;
}

/** A keycap's number as the picture shows it, such as "7" or "11–12". */
export function keycapNumber(keys: readonly ActionKey[]): string {
  return keys.map((key) => actionKeyIndex(key) + 1).join("–");
}

/** The legend's entries, in key order: keys 1–6, the keycaps of keys 7–13, the dial, the joystick. */
export function legendEntries(
  settings: KeypadSettings,
  status: KeypadStatus | undefined,
): LegendEntry[] {
  const mode = status?.topKeyMode ?? settings.topKeys.mode;
  const entries: LegendEntry[] = [];
  for (let key = 0; key < WORKSPACE_KEY_COUNT; key += 1) {
    entries.push({ mark: String(key + 1), text: topKeyLabel(mode, key, status?.keys[key]) });
  }
  for (const cap of actionKeycaps(settings)) {
    const leader = groupLeader(settings.keyGroups, cap[0] ?? "ACT06");
    entries.push({ mark: keycapNumber(cap), text: bindingText(settings, leader) });
  }
  entries.push({
    mark: "Dial",
    text: `${bindingText(settings, "dialCounterclockwise")}, ${bindingText(settings, "dialClockwise")}; click: ${bindingText(settings, "dialPress")}`,
  });
  const radial = settings.radialMenu;
  entries.push({
    mark: "Joystick",
    text: radial.enabled
      ? `Radial menu: ${radial.slots
          .filter((slot) => slot.action !== "none")
          .map((slot) => slot.label)
          .join(", ")}`
      : JOYSTICK_DIRECTIONS.map(
          (direction) =>
            `${ACTION_INPUT_LABELS[direction].replace("Joystick ", "")}: ${bindingText(settings, direction)}`,
        ).join("; "),
  });
  return entries;
}

/**
 * What each key, the dial, and the joystick do, numbered as in the picture, in two columns
 * where they fit. Read-only; the settings screen changes them.
 */
export function KeyLegend({
  theme,
  settings,
  status,
}: {
  theme: PluginTheme;
  settings: KeypadSettings;
  status: KeypadStatus | undefined;
}) {
  const styles = useMemo(
    () => ({
      list: { flexDirection: "row" as const, flexWrap: "wrap" as const, rowGap: 6 },
      entry: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
        width: "50%" as const,
        minWidth: 220,
        flexGrow: 1,
        paddingRight: 12,
      },
      wide: { width: "100%" as const },
      mark: {
        width: 58,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        color: theme.colors.foreground,
        fontSize: 11,
        fontWeight: "600" as const,
        textAlign: "center" as const,
        fontVariant: ["tabular-nums" as const],
      },
      text: { flex: 1, color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme],
  );
  return (
    <View style={styles.list} accessibilityLabel="What each key does">
      {legendEntries(settings, status).map((entry) => {
        const part = entry.mark === "Dial" || entry.mark === "Joystick";
        return (
          <View key={entry.mark} style={[styles.entry, part ? styles.wide : null]}>
            <Text style={styles.mark}>{entry.mark}</Text>
            <Text style={styles.text} numberOfLines={part ? 2 : 1}>
              {entry.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
