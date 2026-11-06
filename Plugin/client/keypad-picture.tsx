import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTIONS } from "../shared/actions";
import { groupLeader, groupOf } from "../shared/key-groups";
import {
  ACTION_INPUT_LABELS,
  WORKSPACE_KEY_COUNT,
  KEY_ROWS,
  keyActionInput,
  keyName,
  type ActionInput,
  type JoystickDirection,
} from "../shared/keypad";
import type { KeypadStatus } from "../shared/rpc";
import type { KeypadSettings } from "../shared/settings";
import { joystickDetail, lightSwatch, topKeyLabel } from "./summary";

/** An input chosen in the picture: a top key (`workspaceKey`, keys 0–5) or an action input. */
export type PictureSelection =
  | { kind: "workspaceKey"; key: number }
  | { kind: "input"; input: ActionInput }
  | { kind: "radialMenu" };

interface KeypadPictureProps {
  theme: PluginTheme;
  settings: KeypadSettings;
  status: KeypadStatus | undefined;
  selection: PictureSelection | null;
  onSelect: (selection: PictureSelection) => void;
}

const KEY_SIZE = 64;
const GAP = 8;

/** Splits a row into runs of keys under one keycap; other keys stand alone. */
function keycaps(row: readonly number[], settings: KeypadSettings): number[][] {
  const runs: number[][] = [];
  for (const key of row) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    const input = keyActionInput(key);
    const before = previous === undefined ? null : keyActionInput(previous);
    if (run && input && before && groupOf(settings.keyGroups, before).includes(input)) {
      run.push(key);
    } else {
      runs.push([key]);
    }
  }
  return runs;
}

const ARROWS: Readonly<Record<JoystickDirection, string>> = {
  joystickUp: "▲ Up",
  joystickDown: "▼ Down",
  joystickLeft: "◀ Left",
  joystickRight: "▶ Right",
};

function shortLabel(text: string, length = 14): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * A schematic of the Creator Micro 2: the dial's turns, click, and held turns,
 * the joystick's four directions with their prompts, then the keys in rows of 2, 4, 4, and 3.
 * The top keys show what their mode puts on them, such as a workspace or a navigation action,
 * with their current light; the other inputs show their action.
 * Keys under one keycap show as one wide key.
 */
export function KeypadPicture({
  theme,
  settings,
  status,
  selection,
  onSelect,
}: KeypadPictureProps) {
  const styles = useMemo(
    () => ({
      frame: {
        gap: 8,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        alignSelf: "flex-start" as const,
      },
      row: { flexDirection: "row" as const, gap: GAP },
      key: {
        width: KEY_SIZE,
        height: KEY_SIZE,
        borderRadius: 8,
        borderWidth: 2,
        padding: 4,
        justifyContent: "space-between" as const,
      },
      code: { fontSize: 9, color: theme.colors.foregroundMuted },
      label: { fontSize: 10, color: theme.colors.foreground },
      joystick: { gap: 4, alignItems: "center" as const, alignSelf: "flex-start" as const },
      direction: {
        width: KEY_SIZE * 2,
        minHeight: 40,
        borderRadius: 8,
        borderWidth: 2,
        paddingHorizontal: 6,
        paddingVertical: 2,
        justifyContent: "center" as const,
      },
      control: {
        minWidth: KEY_SIZE,
        height: 32,
        borderRadius: 16,
        borderWidth: 2,
        paddingHorizontal: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
    }),
    [theme],
  );

  const border = (selected: boolean) => (selected ? theme.colors.accent : theme.colors.border);
  const isInput = (input: ActionInput) => selection?.kind === "input" && selection.input === input;

  /** One keycap over one or more action keys; a shared keycap runs its first key's binding. */
  function actionKey(keys: readonly number[]) {
    const first = keys[0];
    const input = first === undefined ? null : keyActionInput(first);
    if (first === undefined || !input) return null;
    const leader = groupLeader(settings.keyGroups, input);
    const action = settings.bindings[leader].action;
    const name = keyName(...keys);
    // A key with a light source shows the light that the plugin sends it;
    // the keypad shows it only on a layer that binds the key to an AG code.
    const own = status?.actionKeys.find((entry) => entry.key === first)?.light;
    return (
      <Pressable
        key={first}
        accessibilityRole="button"
        accessibilityLabel={`${name}: ${ACTIONS[action].label}`}
        onPress={() => onSelect({ kind: "input", input: leader })}
        style={[
          styles.key,
          {
            width: KEY_SIZE * keys.length + GAP * (keys.length - 1),
            borderColor: border(isInput(leader)),
            backgroundColor: lightSwatch(own ?? settings.lights.keysZone, theme.colors.surface2),
          },
        ]}
      >
        <Text style={styles.code}>{name}</Text>
        <Text style={styles.label} numberOfLines={2}>
          {action === "none" ? "—" : shortLabel(ACTIONS[action].label, 22)}
        </Text>
      </Pressable>
    );
  }

  function workspaceKey(key: number) {
    const info = status?.keys[key];
    const selected = selection?.kind === "workspaceKey" && selection.key === key;
    const title = topKeyLabel(status?.topKeyMode ?? settings.topKeys.mode, key, info);
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={`${keyName(key)}: ${title}${info?.pinned ? ", pinned" : ""}`}
        onPress={() => onSelect({ kind: "workspaceKey", key })}
        style={[
          styles.key,
          {
            borderColor: border(selected),
            backgroundColor: lightSwatch(info?.light, theme.colors.surface2),
          },
        ]}
      >
        <Text style={styles.code}>
          {keyName(key)}
          {info?.pinned ? " · pinned" : ""}
        </Text>
        <Text style={styles.label} numberOfLines={2}>
          {shortLabel(title, 22)}
        </Text>
      </Pressable>
    );
  }

  function control(input: ActionInput, label: string) {
    const action = settings.bindings[input].action;
    return (
      <Pressable
        key={input}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${ACTIONS[action].label}`}
        onPress={() => onSelect({ kind: "input", input })}
        style={[
          styles.control,
          { borderColor: border(isInput(input)), backgroundColor: theme.colors.surface2 },
        ]}
      >
        <Text style={styles.label}>{label}</Text>
      </Pressable>
    );
  }

  /** The joystick's radial menu, which replaces the four directions while it is on. */
  function radialMenu() {
    const selected = selection?.kind === "radialMenu";
    const { enabled, slots } = settings.radialMenu;
    const labels = slots.map((slot) => slot.label).join(" · ");
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Joystick radial menu: ${enabled ? labels : "off"}`}
        onPress={() => onSelect({ kind: "radialMenu" })}
        style={[
          styles.direction,
          {
            width: KEY_SIZE * 4 + GAP * 3,
            borderColor: border(selected),
            backgroundColor: theme.colors.surface2,
          },
        ]}
      >
        <Text style={styles.code}>{enabled ? "◎ Radial menu" : "◎ Radial menu: off"}</Text>
        <Text style={styles.label} numberOfLines={2}>
          {enabled ? labels : "The joystick's directions run their own actions."}
        </Text>
      </Pressable>
    );
  }

  /** A joystick direction with its prompt, or its action when it does not send a prompt. */
  function direction(input: JoystickDirection) {
    const binding = settings.bindings[input];
    const detail = joystickDetail(binding.action, binding.text);
    return (
      <Pressable
        key={input}
        accessibilityRole="button"
        accessibilityLabel={`${ACTION_INPUT_LABELS[input]}: ${detail}`}
        onPress={() => onSelect({ kind: "input", input })}
        style={[
          styles.direction,
          { borderColor: border(isInput(input)), backgroundColor: theme.colors.surface2 },
        ]}
      >
        <Text style={styles.code}>{ARROWS[input]}</Text>
        <Text style={styles.label} numberOfLines={2}>
          {shortLabel(detail, 30)}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.frame} accessibilityLabel="Creator Micro 2 keypad">
      <View style={styles.row}>
        {control("dialCounterclockwise", "Dial ↺")}
        {control("dialPress", "Click")}
        {control("dialClockwise", "Dial ↻")}
      </View>
      <View style={styles.row}>
        {control("dialHeldCounterclockwise", "Held ↺")}
        {control("dialHeldClockwise", "Held ↻")}
      </View>
      <View style={styles.joystick} accessibilityLabel="Joystick">
        {radialMenu()}
        {settings.radialMenu.enabled ? null : (
          <>
            {direction("joystickUp")}
            <View style={styles.row}>
              {direction("joystickLeft")}
              {direction("joystickRight")}
            </View>
            {direction("joystickDown")}
          </>
        )}
      </View>
      {KEY_ROWS.map((row, index) => (
        <View key={index} style={styles.row}>
          {keycaps(row, settings).map((keys) =>
            keys.length === 1 && (keys[0] ?? 0) < WORKSPACE_KEY_COUNT
              ? workspaceKey(keys[0] ?? 0)
              : actionKey(keys),
          )}
        </View>
      ))}
    </View>
  );
}
