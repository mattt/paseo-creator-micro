import type { PluginTheme } from "@getpaseo/plugin";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  Icon,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTION_IDS, ACTIONS, type ActionId } from "../shared/actions";
import {
  DEFAULT_RADIAL_SLOTS,
  RADIAL_COLOR_PRESETS,
  RADIAL_MENU_ICON_LABELS,
  RADIAL_MENU_ICONS,
  RADIAL_SLOT_NAMES,
  type RadialMenuIcon,
} from "../shared/radial-menu";
import type { KeypadStatus } from "../shared/rpc";
import {
  RadialSlotSchema,
  type keypadSettings,
  type KeypadSettings,
  type RadialSlot,
} from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof keypadSettings.schema>, { status: "ready" }>;

/**
 * Lucide icons that look like each SF Symbol, for the picture of the ring;
 * Paseo's settings screen draws Lucide icons, and PaseoMicro draws the SF Symbols.
 */
const PREVIEW_ICONS: Readonly<Record<RadialMenuIcon, string>> = {
  "checkmark.circle": "circle-check",
  "xmark.circle": "circle-x",
  "play.circle": "circle-play",
  "stop.circle": "circle-stop",
  "pause.circle": "circle-pause",
  "testtube.2": "test-tubes",
  magnifyingglass: "search",
  "arrow.triangle.branch": "git-branch",
  "list.bullet": "list",
  "arrow.down.to.line": "arrow-down-to-line",
  "arrow.uturn.backward": "undo-2",
  "arrow.uturn.backward.circle": "circle-arrow-left",
  "arrow.uturn.forward.circle": "circle-arrow-right",
  "arrow.clockwise": "rotate-cw",
  sparkles: "sparkles",
  hammer: "hammer",
  ant: "bug",
  "doc.text": "file-text",
  "text.bubble": "message-square-text",
  "questionmark.circle": "circle-help",
  lightbulb: "lightbulb",
  flag: "flag",
  trash: "trash-2",
  paperplane: "send",
  mic: "mic",
  brain: "brain",
  bolt: "zap",
  terminal: "terminal",
  shippingbox: "package",
  eye: "eye",
  pencil: "pencil",
  folder: "folder",
  star: "star",
  bookmark: "bookmark",
};

const ICON_OPTIONS = RADIAL_MENU_ICONS.map((icon) => ({
  value: icon,
  label: `${RADIAL_MENU_ICON_LABELS[icon]} (${icon})`,
}));

const ACTION_OPTIONS = ACTION_IDS.map((id) => ({
  value: id,
  label: id === "none" ? "Nothing (empty slot)" : ACTIONS[id].label,
}));

const DEFAULT_COLOR = "default";

function colorOptions(current: string | null) {
  const options = [
    { value: DEFAULT_COLOR, label: "Default (white)" },
    ...RADIAL_COLOR_PRESETS.map((preset) => ({
      value: preset.color,
      label: `${preset.label} (${preset.color})`,
    })),
  ];
  if (current !== null && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

/** Where each slot sits in a 3 × 3 grid around the center: slot 0 at the top, then clockwise. */
const GRID: readonly (readonly (number | "center")[])[] = [
  [7, 0, 1],
  [6, "center", 2],
  [5, 4, 3],
];

const CELL = 84;

/**
 * A picture of the radial menu as PaseoMicro draws it: the eight slots around the agent
 * that it acts on, with each slot's icon, label, and color, dimmed when it cannot act now.
 */
function RadialMenuRing({
  theme,
  slots,
  status,
  selected,
  onSelect,
}: {
  theme: PluginTheme;
  slots: readonly RadialSlot[];
  status: KeypadStatus["radialMenu"] | undefined;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const styles = useMemo(
    () => ({
      frame: {
        gap: 6,
        padding: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        alignSelf: "flex-start" as const,
      },
      row: { flexDirection: "row" as const, gap: 6 },
      cell: {
        width: CELL,
        height: CELL,
        borderRadius: CELL / 2,
        borderWidth: 2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 2,
        padding: 4,
      },
      label: { fontSize: 11, color: theme.colors.foreground, textAlign: "center" as const },
      muted: { fontSize: 9, color: theme.colors.foregroundMuted, textAlign: "center" as const },
    }),
    [theme],
  );
  const target = status?.target ?? null;
  return (
    <View style={styles.frame} accessibilityLabel="Radial menu">
      {GRID.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((cell) => {
            if (cell === "center") {
              return (
                <View key="center" style={[styles.cell, { borderColor: "transparent" }]}>
                  <Text style={styles.muted}>{target ? "Acts on" : "No agent"}</Text>
                  {target ? (
                    <Text style={styles.label} numberOfLines={3}>
                      {target}
                    </Text>
                  ) : null}
                </View>
              );
            }
            const slot = slots[cell];
            if (!slot) return null;
            const blocker = status?.blockers[cell] ?? null;
            const color = slot.color ?? theme.colors.foreground;
            return (
              <Pressable
                key={cell}
                accessibilityRole="button"
                accessibilityLabel={`${RADIAL_SLOT_NAMES[cell]}: ${slot.label}${blocker ? `, dimmed: ${blocker}` : ""}`}
                onPress={() => onSelect(cell)}
                style={[
                  styles.cell,
                  {
                    borderColor: cell === selected ? theme.colors.accent : `${color}55`,
                    backgroundColor: theme.colors.surface2,
                    opacity: blocker ? 0.45 : 1,
                  },
                ]}
              >
                <Icon name={PREVIEW_ICONS[slot.icon]} size={20} color={color} />
                <Text style={styles.label} numberOfLines={1}>
                  {slot.label}
                </Text>
                <Text style={styles.muted}>{RADIAL_SLOT_NAMES[cell]}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** The radial menu's switch, a picture of its ring, and an editor for the chosen slot. */
export function RadialMenuEditor({
  theme,
  settings,
  status,
  save,
}: {
  theme: PluginTheme;
  settings: ReadySettings;
  status: KeypadStatus | undefined;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const menu = values.radialMenu;
  const [selected, setSelected] = useState(0);
  const setMenu = (next: Partial<KeypadSettings["radialMenu"]>) =>
    save({ ...values, radialMenu: { ...menu, ...next } });
  const setSlot = (index: number, slot: RadialSlot) =>
    setMenu({ slots: menu.slots.map((each, at) => (at === index ? slot : each)) });
  const slot = menu.slots[selected];
  return (
    <>
      <SettingsCard>
        <SettingsSwitch
          label="Radial menu"
          hint="Push the joystick to show eight choices over Paseo's window, point at one, and let go to run it. Return the stick to the center slowly to cancel. While the menu is on, the joystick's four direction bindings do nothing; they work again when you turn it off."
          value={menu.enabled}
          disabled={settings.saving}
          onValueChange={(enabled) => setMenu({ enabled })}
        />
        <SettingsRow
          label="Slots"
          hint="The menu acts on the selected workspace's agent, named in the center. A slot that cannot act now, such as Approve without a pending request, is dimmed. Choose a slot to change it."
        >
          <RadialMenuRing
            theme={theme}
            slots={menu.slots}
            status={status?.radialMenu}
            selected={selected}
            onSelect={setSelected}
          />
        </SettingsRow>
      </SettingsCard>
      {slot ? (
        <SlotEditor
          key={selected}
          index={selected}
          slot={slot}
          blocker={status?.radialMenu.blockers[selected] ?? null}
          disabled={settings.saving}
          onChange={(next) => setSlot(selected, next)}
          onRestore={() => setMenu({ slots: DEFAULT_RADIAL_SLOTS.map((each) => ({ ...each })) })}
        />
      ) : null}
    </>
  );
}

function SlotEditor({
  index,
  slot,
  blocker,
  disabled,
  onChange,
  onRestore,
}: {
  index: number;
  slot: RadialSlot;
  blocker: string | null;
  disabled: boolean;
  onChange: (slot: RadialSlot) => void;
  onRestore: () => void;
}) {
  const [label, setLabel] = useState(slot.label);
  const [text, setText] = useState(slot.text);
  const parsedLabel = RadialSlotSchema.shape.label.safeParse(label);
  const labelError = parsedLabel.success ? null : (parsedLabel.error.issues[0]?.message ?? null);
  const changed = label.trim() !== slot.label || text !== slot.text;
  const name = RADIAL_SLOT_NAMES[index] ?? `Slot ${index}`;
  return (
    <SettingsCard>
      <SettingsRow
        label={`${name}: ${slot.label}`}
        hint={blocker ? `Dimmed now: ${blocker}.` : "Can act now."}
      />
      <SettingsSelect
        label="Icon"
        hint="PaseoMicro draws this SF Symbol."
        value={slot.icon}
        options={ICON_OPTIONS}
        disabled={disabled}
        onValueChange={(icon) => onChange({ ...slot, icon })}
      />
      <SettingsSelect
        label="Color"
        value={slot.color ?? DEFAULT_COLOR}
        options={colorOptions(slot.color)}
        disabled={disabled}
        onValueChange={(color) =>
          onChange({ ...slot, color: color === DEFAULT_COLOR ? null : color })
        }
      />
      <SettingsSelect
        label="Action"
        hint={ACTIONS[slot.action].description}
        value={slot.action}
        options={ACTION_OPTIONS}
        disabled={disabled}
        onValueChange={(action: ActionId) => onChange({ ...slot, action })}
      />
      <SettingsInput
        label="Label"
        hint="One or two words under the icon."
        initialValue={slot.label}
        error={labelError}
        disabled={disabled}
        onChangeText={setLabel}
      />
      {slot.action === "sendPrompt" ? (
        <SettingsInput
          label="Prompt"
          hint="Sent to the agent that the menu acts on. With no prompt, the slot is dimmed."
          initialValue={slot.text}
          placeholder="Continue"
          disabled={disabled}
          onChangeText={setText}
        />
      ) : null}
      <SettingsAction
        label="Label and prompt changes"
        actionLabel="Save"
        disabled={disabled || !changed || !parsedLabel.success}
        onPress={() => parsedLabel.success && onChange({ ...slot, label: parsedLabel.data, text })}
      />
      <SettingsAction
        label="Default slots"
        actionLabel="Restore"
        disabled={disabled}
        onPress={onRestore}
      />
    </SettingsCard>
  );
}
