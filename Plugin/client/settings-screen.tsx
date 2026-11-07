import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  Icon,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTION_IDS, ACTIONS, type ActionId } from "../shared/actions";
import { groupLeader, groupOf, joinKeys } from "../shared/key-groups";
import {
  ACTION_INPUT_LABELS,
  ACTION_KEYS,
  actionKeyIndex,
  isActionKey,
  JOYSTICK_DIRECTIONS,
  KEY_ROWS,
  WORKSPACE_KEY_COUNT,
  keyActionInput,
  keyName,
  type ActionInput,
  type ActionKey,
} from "../shared/keypad";
import { reconnectRpc, type KeypadStatus } from "../shared/rpc";
import {
  ACTION_KEY_LIGHT_SOURCES,
  ColorSchema,
  DEFAULT_SETTINGS,
  KEY_STATE_LABELS,
  KEY_STATES,
  keypadSettings,
  LIGHT_EFFECTS,
  LIGHT_SOURCE_LABELS,
  SettingsSchema,
  TARGET_FALLBACK_LABELS,
  TARGET_FALLBACKS,
  TOP_KEY_MODE_LABELS,
  TOP_KEY_MODES,
  UNDERGLOW_SOURCES,
  type ActionKeyLightSource,
  type KeypadSettings,
  type LightEffect,
  type LightStyle,
  type TargetFallback,
  type TopKeyMode,
  type UnderglowSource,
} from "../shared/settings";
import { actionKeycaps, keycapNumber } from "./key-legend";
import { KeypadPicture, type PictureSelection } from "./keypad-picture";
import { unpinKey } from "./pins";
import { RadialMenuEditor } from "./radial-menu-editor";
import { useKeypadStatus } from "./status";
import { connectionDetail, summarize, topKeyLabel } from "./summary";

type ReadySettings = Extract<SettingsState<typeof keypadSettings.schema>, { status: "ready" }>;
type Save = (values: KeypadSettings) => void;

const ACTION_OPTIONS = ACTION_IDS.map((id) => ({ value: id, label: ACTIONS[id].label }));

const TOP_KEY_MODE_OPTIONS = TOP_KEY_MODES.map((mode) => ({
  value: mode,
  label: TOP_KEY_MODE_LABELS[mode],
}));

/** What each top-key mode does, for the mode picker's hint. */
const TOP_KEY_MODE_HINTS: Readonly<Record<TopKeyMode, string>> = {
  navigation: "Go back and forward, and switch workspaces and projects.",
  recentAgents: "Your six latest agents. Tap to select; double-tap to open.",
  workspaces: "Your six latest workspaces. Press to open.",
  pinned: "Only the workspaces that you pin to keys. Press to open.",
  off: "The top keys are dark and do nothing.",
};

const TARGET_FALLBACK_OPTIONS = TARGET_FALLBACKS.map((fallback) => ({
  value: fallback,
  label: TARGET_FALLBACK_LABELS[fallback],
}));

const UNDERGLOW_OPTIONS = UNDERGLOW_SOURCES.map((source) => ({
  value: source,
  label: LIGHT_SOURCE_LABELS[source],
}));

const ACTION_KEY_LIGHT_OPTIONS = ACTION_KEY_LIGHT_SOURCES.map((source) => ({
  value: source,
  label: LIGHT_SOURCE_LABELS[source],
}));

const EFFECT_LABELS: Record<LightEffect, string> = {
  off: "Off",
  solid: "Solid",
  snake: "Snake",
  rainbow: "Rainbow",
  breathing: "Breathing",
  gradient: "Gradient",
  shallowBreathing: "Shallow breathing",
};
const EFFECT_OPTIONS = LIGHT_EFFECTS.map((effect) => ({
  value: effect,
  label: EFFECT_LABELS[effect],
}));

/** What each state's light means on a top key. */
const STATE_HINTS: Readonly<Record<(typeof KEY_STATES)[number], string>> = {
  failed: "A top key whose agent failed.",
  needsInput: "A top key whose agent needs your input.",
  running: "A top key whose agent is working.",
  done: "A top key whose agent finished and you haven't looked yet.",
  idle: "A top key whose agents are idle or read.",
  empty: "A top key with no workspace or agent.",
};

/** The lights that people can restyle, in the order of the light picker. */
type StyledLight =
  | (typeof KEY_STATES)[number]
  | "selectedOff"
  | "navigation"
  | "keysZone"
  | "underglowStyle"
  | "meter"
  | "meterOff"
  | "failure";

const STYLED_LIGHTS: readonly { value: StyledLight; label: string; hint: string }[] = [
  ...KEY_STATES.map((state) => ({
    value: state,
    label: KEY_STATE_LABELS[state],
    hint: STATE_HINTS[state],
  })),
  {
    value: "selectedOff",
    label: "Selected, otherwise dark",
    hint: "The selected key when its own light is off.",
  },
  {
    value: "navigation",
    label: "Navigation key",
    hint: "A navigation key that can act now. Keys that can't act are dark.",
  },
  { value: "keysZone", label: "Other keys", hint: "The keys below the top keys." },
  {
    value: "underglowStyle",
    label: "Underglow",
    hint: "The light under the keypad while an agent needs input.",
  },
  {
    value: "meter",
    label: "Thinking level",
    hint: "After a thinking change, the top keys show the new level for a moment.",
  },
  { value: "meterOff", label: "Thinking level, unlit", hint: "The rest of the top keys." },
  {
    value: "failure",
    label: "Thinking change failed",
    hint: "The top keys flash when a thinking change fails.",
  },
];

function percentOptions(current: number) {
  const values = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  if (!values.includes(current)) values.push(current);
  return values
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: `${Math.round(value * 100)}%` }));
}

function choiceOptions(values: number[], current: number, label: (value: number) => string) {
  const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  return all.map((value) => ({ value: String(value), label: label(value) }));
}

const lines = (count: number) => (count === 1 ? "1 line" : `${count} lines`);

/** What to do about the keypad's status, or how it connects when it works. */
function statusHint(status: KeypadStatus | undefined, failed: boolean): string | undefined {
  if (failed) return "Keypad status isn't available. Paseo tries again in a moment.";
  if (status?.settings.error) return status.settings.error;
  if (status?.bridge.state === "waiting") {
    return "Paseo Micro is the menu bar app that connects your keypad to Paseo.";
  }
  if (status?.bridge.state === "connected" && status.keypad && !status.keypad.connected) {
    return "Connect the keypad with a USB cable or Bluetooth.";
  }
  return connectionDetail(status) ?? undefined;
}

export function KeypadSettingsScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(keypadSettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  if (settings.status === "loading") return <Text style={textStyle}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Keypad">
        <SettingsCard>
          <SettingsRow label="The keypad settings can't be read" error={settings.error} />
          <SettingsAction label="Read them again" actionLabel="Reload" onPress={settings.reload} />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="Restore the default settings"
              hint="Replaces every keypad setting."
              actionLabel="Reset"
              onPress={settings.reset}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <ReadyScreen settings={settings} theme={theme} hostId={host.id} />;
}

function ReadyScreen({
  settings,
  theme,
  hostId,
}: {
  settings: ReadySettings;
  theme: PluginTheme;
  hostId: string;
}) {
  const status = useKeypadStatus(hostId);
  const reconnect = useRpc(reconnectRpc);
  const [selection, setSelection] = useState<PictureSelection>({ kind: "input", input: "ACT06" });
  const values = settings.values;
  const save = useCallback<Save>((next) => void settings.save(next, settings.revision), [settings]);
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger, fontSize: 13 }), [theme]);
  const data = status.data;

  return (
    <>
      <SettingsSection title="Keypad">
        <SettingsCard>
          <SettingsRow label={summarize(data)} hint={statusHint(data, status.error !== null)} />
          {data?.bridge.state === "waiting" ? (
            <SettingsAction
              label="Already open?"
              actionLabel="Reconnect"
              onPress={() => void reconnect({}).then(() => status.refetch())}
            />
          ) : null}
          <SettingsRow
            label="Keys"
            hint="Choose a key, the dial, or the joystick to find its setting below."
          >
            <KeypadPicture
              theme={theme}
              settings={values}
              status={data}
              selection={selection}
              onSelect={setSelection}
            />
          </SettingsRow>
        </SettingsCard>
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={errorStyle}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
      <TopKeysSection
        theme={theme}
        settings={settings}
        status={data}
        selection={selection}
        save={save}
      />
      <ActionKeysSection theme={theme} settings={settings} selection={selection} save={save} />
      <SettingsSection title="Dial">
        <Highlight theme={theme} card on={selection.kind === "dial"}>
          <SettingsCard>
            {DIAL_INPUTS.map(({ input, label }) => (
              <BindingRows
                key={input}
                input={input}
                label={label}
                settings={settings}
                save={save}
              />
            ))}
          </SettingsCard>
        </Highlight>
      </SettingsSection>
      <SettingsSection title="Joystick">
        <Highlight theme={theme} card on={selection.kind === "joystick"}>
          <JoystickEditor theme={theme} settings={settings} status={data} save={save} />
        </Highlight>
      </SettingsSection>
      <LightsSection settings={settings} save={save} />
      <AgentsSection settings={settings} save={save} />
      <DialAndVoiceSection settings={settings} save={save} />
      <AdvancedSection settings={settings} status={data} theme={theme} save={save} />
    </>
  );
}

/**
 * A select for an input's action, and, for the "send prompt" action, its prompt and a Save button.
 * Rows only; the caller puts them in a card.
 */
function BindingRows({
  input,
  label,
  settings,
  save,
}: {
  input: ActionInput;
  label: string;
  settings: ReadySettings;
  save: Save;
}) {
  const values = settings.values;
  const binding = values.bindings[input];
  const [prompt, setPrompt] = useState(binding.text);
  const setBinding = (next: { action: ActionId; text: string }) =>
    save({ ...values, bindings: { ...values.bindings, [input]: next } });
  return (
    <>
      <SettingsSelect
        label={label}
        hint={ACTIONS[binding.action].description}
        value={binding.action}
        options={ACTION_OPTIONS}
        disabled={settings.saving}
        onValueChange={(action) => setBinding({ ...binding, action })}
      />
      {binding.action === "sendPrompt" ? (
        <SettingsInput
          key={`${input}-prompt`}
          label="Prompt"
          hint="Sent to the selected workspace's agent."
          initialValue={binding.text}
          placeholder="Continue"
          disabled={settings.saving}
          onChangeText={setPrompt}
        />
      ) : null}
      {binding.action === "sendPrompt" && prompt !== binding.text ? (
        <SettingsAction
          key={`${input}-save`}
          label="Unsaved prompt"
          actionLabel="Save"
          disabled={settings.saving}
          onPress={() => setBinding({ ...binding, text: prompt })}
        />
      ) : null}
    </>
  );
}

/** The action key to the right of a key in its row, if any. */
function keyToTheRight(input: ActionKey): ActionKey | null {
  const index = actionKeyIndex(input);
  const row = KEY_ROWS.find((keys) => keys.includes(index));
  const next = row?.[row.indexOf(index) + 1];
  const nextInput = next === undefined ? null : keyActionInput(next);
  return nextInput && isActionKey(nextInput) ? nextInput : null;
}

/**
 * Marks the settings of the part chosen in the picture, so that the rows below the picture
 * show which one belongs to it: a row gets a tint and a bar in the accent color,
 * and a whole card gets an outline in the accent color.
 */
function Highlight({
  theme,
  on,
  card = false,
  children,
}: {
  theme: PluginTheme;
  on: boolean;
  card?: boolean;
  children: ReactNode;
}) {
  const accent = theme.colors.accent;
  const tint = /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}1f` : "transparent";
  const style = card
    ? {
        borderRadius: 14,
        borderWidth: 2,
        borderColor: on ? accent : "transparent",
        margin: -4,
        padding: 2,
      }
    : { backgroundColor: on ? tint : "transparent" };
  return (
    <View style={style}>
      {children}
      {on && !card ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: accent,
          }}
        />
      ) : null}
    </View>
  );
}

const DIAL_INPUTS: readonly { input: ActionInput; label: string }[] = [
  { input: "dialCounterclockwise", label: "Turn left" },
  { input: "dialClockwise", label: "Turn right" },
  { input: "dialPress", label: "Click" },
  { input: "dialHeldCounterclockwise", label: "Hold and turn left" },
  { input: "dialHeldClockwise", label: "Hold and turn right" },
];

/** Keys 7 to 13, one row per keycap in key order, each with its action. */
function ActionKeysSection({
  theme,
  settings,
  selection,
  save,
}: {
  theme: PluginTheme;
  settings: ReadySettings;
  selection: PictureSelection;
  save: Save;
}) {
  const values = settings.values;
  return (
    <SettingsSection title="Keys 7 to 13">
      <SettingsCard>
        {actionKeycaps(values).map((cap) => {
          const leader = groupLeader(values.keyGroups, cap[0] ?? "ACT06");
          const chosen = selection.kind === "input" && cap.some((key) => key === selection.input);
          return (
            <Highlight key={leader} theme={theme} on={chosen}>
              <BindingRows
                input={leader}
                label={`${cap.length > 1 ? "Keys" : "Key"} ${keycapNumber(cap)}`}
                settings={settings}
                save={save}
              />
            </Highlight>
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Switches for the pairs of neighboring keys that one double-wide keycap can cover. */
function KeycapsCard({ settings, save }: { settings: ReadySettings; save: Save }) {
  const values = settings.values;
  const pairs: [ActionKey, ActionKey][] = [];
  for (const key of ACTION_KEYS) {
    const right = keyToTheRight(key);
    if (right) pairs.push([key, right]);
  }
  return (
    <SettingsCard>
      <SettingsRow
        label="Double-wide keycaps"
        hint="Turn on a pair that one keycap covers, so that a press of either key acts once."
      />
      {pairs.map(([left, right]) => {
        const joined = groupOf(values.keyGroups, left).includes(right);
        return (
          <SettingsSwitch
            key={left}
            label={`Keys ${keycapNumber([left])} and ${keycapNumber([right])}`}
            value={joined}
            disabled={settings.saving}
            onValueChange={(on) =>
              save({
                ...values,
                keyGroups: on
                  ? joinKeys(values.keyGroups, left, right)
                  : values.keyGroups.filter(
                      (keys) => !(keys.includes(left) && keys.includes(right)),
                    ),
              })
            }
          />
        );
      })}
    </SettingsCard>
  );
}

/** The radial menu, or, while it is off, an action for each of the joystick's directions. */
function JoystickEditor({
  theme,
  settings,
  status,
  save,
}: {
  theme: PluginTheme;
  settings: ReadySettings;
  status: KeypadStatus | undefined;
  save: Save;
}) {
  const values = settings.values;
  if (values.radialMenu.enabled) {
    return <RadialMenuEditor theme={theme} settings={settings} status={status} save={save} />;
  }
  return (
    <SettingsCard>
      <RadialMenuSwitch settings={settings} save={save} />
      {JOYSTICK_DIRECTIONS.map((direction) => (
        <BindingRows
          key={direction}
          input={direction}
          label={ACTION_INPUT_LABELS[direction].replace("Joystick", "Push")}
          settings={settings}
          save={save}
        />
      ))}
    </SettingsCard>
  );
}

export function RadialMenuSwitch({ settings, save }: { settings: ReadySettings; save: Save }) {
  const values = settings.values;
  return (
    <SettingsSwitch
      label="Radial menu"
      hint="Push the joystick to show eight choices, then let go on one. The joystick works only on a keypad layer that sends its directions."
      value={values.radialMenu.enabled}
      disabled={settings.saving}
      onValueChange={(enabled) =>
        save({ ...values, radialMenu: { ...values.radialMenu, enabled } })
      }
    />
  );
}

/** The hint for a top key in the picture, by the top keys' mode. */
function topKeyHint(
  mode: TopKeyMode,
  slot: number,
  info: KeypadStatus["keys"][number] | undefined,
  openOnSingleTap: boolean,
): string {
  switch (mode) {
    case "navigation": {
      const description = info?.action ? ACTIONS[info.action].description : "";
      const idle = info && !info.enabled ? " Nothing to do now." : "";
      return `${description}${idle} Choose what the top keys do under Top keys.`;
    }
    case "recentAgents":
      return `${describeKey(info, "agent")} ${openOnSingleTap ? "Tap to open." : "Tap to select; double-tap to open."}`;
    case "workspaces":
    case "pinned":
      return `${describeKey(info, "workspace")} Press to open. To pin a workspace here, open it and choose "Creator Micro: pin workspace to key ${slot + 1}" in the Command Center.`;
    case "off":
      return "The top keys are off. Choose what they do under Top keys.";
  }
}

function describeKey(
  info: KeypadStatus["keys"][number] | undefined,
  kind: "workspace" | "agent",
): string {
  if (!info) return "";
  if (info.state === "empty") return kind === "agent" ? "No agent." : `${KEY_STATE_LABELS.empty}.`;
  if (kind === "agent") {
    return `${KEY_STATE_LABELS[info.state]}${info.project ? ` (${info.project})` : ""}.`;
  }
  const agents = info.agentCount === 1 ? "1 agent" : `${info.agentCount} agents`;
  const project = info.project ? `${info.project}, ` : "";
  return `${KEY_STATE_LABELS[info.state]} (${project}${agents}).`;
}

/** The top keys' mode, and keys 1 to 6 in order with what each shows now and its pin. */
function TopKeysSection({
  theme,
  settings,
  status,
  selection,
  save,
}: {
  theme: PluginTheme;
  settings: ReadySettings;
  status: KeypadStatus | undefined;
  selection: PictureSelection;
  save: Save;
}) {
  const values = settings.values;
  const topKeys = values.topKeys;
  const mode = status?.topKeyMode ?? topKeys.mode;
  return (
    <SettingsSection title="Keys 1 to 6">
      <SettingsCard>
        <SettingsSelect
          label="Top keys"
          hint={TOP_KEY_MODE_HINTS[topKeys.mode]}
          value={topKeys.mode}
          options={TOP_KEY_MODE_OPTIONS}
          disabled={settings.saving}
          onValueChange={(next) =>
            save({ ...values, topKeys: { ...topKeys, mode: next as TopKeyMode } })
          }
        />
        {topKeys.mode === "recentAgents" ? (
          <SettingsSwitch
            label="Open on a single tap"
            hint="Open an agent with one tap instead of two."
            value={topKeys.openOnSingleTap}
            disabled={settings.saving}
            onValueChange={(openOnSingleTap) =>
              save({ ...values, topKeys: { ...topKeys, openOnSingleTap } })
            }
          />
        ) : null}
        {Array.from({ length: WORKSPACE_KEY_COUNT }, (_, slot) => {
          const info = status?.keys[slot];
          const pinned = values.pins[slot] ?? null;
          const chosen = selection.kind === "workspaceKey" && selection.key === slot;
          const label = `${keyName(slot)}: ${topKeyLabel(mode, slot, info)}`;
          const hint = chosen ? topKeyHint(mode, slot, info, topKeys.openOnSingleTap) : undefined;
          return (
            <Highlight key={slot} theme={theme} on={chosen}>
              {pinned && (mode === "workspaces" || mode === "pinned") ? (
                <SettingsAction
                  label={
                    info?.workspaceId === pinned
                      ? `${label}, pinned`
                      : `${keyName(slot)}: pinned workspace not available`
                  }
                  hint={hint}
                  actionLabel="Unpin"
                  disabled={settings.saving}
                  onPress={() => save({ ...values, pins: unpinKey(values.pins, slot) })}
                />
              ) : (
                <SettingsRow label={label} hint={hint} />
              )}
            </Highlight>
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

/** A light's color, effect, and brightness. Rows only; the caller puts them in a card. */
function LightStyleRows({
  style,
  disabled,
  onChange,
}: {
  style: LightStyle;
  disabled: boolean;
  onChange: (style: LightStyle) => void;
}) {
  const [colorError, setColorError] = useState<string | null>(null);
  const changeColor = (text: string) => {
    const parsed = ColorSchema.safeParse(text);
    if (!parsed.success) {
      setColorError("Enter a color such as #FFD000.");
      return;
    }
    setColorError(null);
    if (parsed.data !== style.color) onChange({ ...style, color: parsed.data });
  };
  return (
    <>
      <SettingsInput
        label="Color"
        hint="A hex color, such as #FFD000."
        initialValue={style.color}
        placeholder="#RRGGBB"
        error={colorError}
        disabled={disabled}
        onChangeText={changeColor}
      />
      <SettingsSelect
        label="Effect"
        value={style.effect}
        options={EFFECT_OPTIONS}
        disabled={disabled}
        onValueChange={(effect) => onChange({ ...style, effect })}
      />
      <SettingsSelect
        label="Brightness"
        value={String(style.brightness)}
        options={percentOptions(style.brightness)}
        disabled={disabled}
        onValueChange={(value) => onChange({ ...style, brightness: Number(value) })}
      />
    </>
  );
}

function LightsSection({ settings, save }: { settings: ReadySettings; save: Save }) {
  const values = settings.values;
  const lights = values.lights;
  const [chosen, setChosen] = useState<StyledLight>("needsInput");
  const entry = STYLED_LIGHTS.find((light) => light.value === chosen) ?? STYLED_LIGHTS[0];
  const setLights = (next: Partial<KeypadSettings["lights"]>) =>
    save({ ...values, lights: { ...lights, ...next } });
  const underglowUnused = chosen === "underglowStyle" && lights.underglowSource !== "anyNeedsInput";
  return (
    <SettingsSection title="Lights">
      <SettingsCard>
        <SettingsSelect
          label="Underglow"
          hint="The light under the keypad and around its edge."
          value={lights.underglowSource}
          options={UNDERGLOW_OPTIONS}
          disabled={settings.saving}
          onValueChange={(value) => setLights({ underglowSource: value as UnderglowSource })}
        />
        <SettingsSelect
          label="Selected key"
          hint="How much brighter the selected workspace's key is."
          value={String(lights.selectedBrightness)}
          options={choiceOptions([1, 1.5, 2, 3, 4], lights.selectedBrightness, (v) => `${v}×`)}
          disabled={settings.saving}
          onValueChange={(value) => setLights({ selectedBrightness: Number(value) })}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsSelect
          label="Light"
          hint={
            underglowUnused
              ? `${entry?.hint ?? ""} Used when the underglow is set to "${LIGHT_SOURCE_LABELS.anyNeedsInput}".`
              : (entry?.hint ?? undefined)
          }
          value={chosen}
          options={STYLED_LIGHTS.map(({ value, label }) => ({ value, label }))}
          onValueChange={(value) => setChosen(value)}
        />
        <LightStyleRows
          key={chosen}
          style={lights[chosen]}
          disabled={settings.saving}
          onChange={(style) => setLights({ [chosen]: style })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function AgentsSection({ settings, save }: { settings: ReadySettings; save: Save }) {
  const values = settings.values;
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSelect
          label="With no workspace selected"
          hint="The agent that keys, the dial, and the joystick act on."
          value={values.targets.fallback}
          options={TARGET_FALLBACK_OPTIONS}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, targets: { ...values.targets, fallback: value as TargetFallback } })
          }
        />
        <SettingsSwitch
          label="Include subagents"
          hint="Show and count agents that other agents start."
          value={values.agents.includeSubagents}
          disabled={settings.saving}
          onValueChange={(includeSubagents) =>
            save({ ...values, agents: { ...values.agents, includeSubagents } })
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function DialAndVoiceSection({ settings, save }: { settings: ReadySettings; save: Save }) {
  const values = settings.values;
  const scroll = values.scroll;
  const pushToTalk = values.pushToTalk;
  return (
    <SettingsSection title="Scrolling and dictation">
      <SettingsCard>
        <SettingsSelect
          label="Scroll per dial step"
          value={String(scroll.lines)}
          options={choiceOptions([1, 2, 3, 4, 5, 6, 8, 10], scroll.lines, lines)}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, scroll: { ...scroll, lines: Number(value) } })
          }
        />
        <SettingsSelect
          label="Scroll per step while held"
          hint="How far one step scrolls while you hold the dial down."
          value={String(scroll.fastLines)}
          options={choiceOptions([5, 10, 15, 20, 30, 40, 60], scroll.fastLines, lines)}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, scroll: { ...scroll, fastLines: Number(value) } })
          }
        />
        <SettingsSwitch
          label="Send dictation on release"
          hint="When you let go of push to talk, send the message."
          value={pushToTalk.sendReturnOnRelease}
          disabled={settings.saving}
          onValueChange={(sendReturnOnRelease) =>
            save({ ...values, pushToTalk: { ...pushToTalk, sendReturnOnRelease } })
          }
        />
        {pushToTalk.sendReturnOnRelease ? (
          <SettingsSelect
            label="Wait before sending"
            hint="Time for the dictated text to reach the message box."
            value={String(pushToTalk.returnDelayMs)}
            options={choiceOptions(
              [0, 250, 400, 600, 800, 1000, 1500, 2000, 3000],
              pushToTalk.returnDelayMs,
              (ms) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`),
            )}
            disabled={settings.saving}
            onValueChange={(value) =>
              save({ ...values, pushToTalk: { ...pushToTalk, returnDelayMs: Number(value) } })
            }
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Rarely changed and technical settings, and details of the keypad, collapsed until asked for. */
function AdvancedSection({
  settings,
  status,
  theme,
  save,
}: {
  settings: ReadySettings;
  status: KeypadStatus | undefined;
  theme: PluginTheme;
  save: Save;
}) {
  const [open, setOpen] = useState(false);
  const styles = useMemo(
    () => ({
      toggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme],
  );
  return (
    <SettingsSection
      title="Advanced"
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? "Hide advanced settings" : "Show advanced settings"}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((current) => !current)}
        >
          <View style={styles.toggle}>
            <Text style={styles.label}>{open ? "Hide" : "Show"}</Text>
            <Icon
              name={open ? "ChevronDown" : "ChevronRight"}
              size={14}
              color={theme.colors.foregroundMuted}
            />
          </View>
        </Pressable>
      }
    >
      {open ? (
        <>
          <KeycapsCard settings={settings} save={save} />
          <KeyLightsCard settings={settings} save={save} />
          <SettingsCard>
            <SettingsSelect
              label="Scroll point"
              hint="How far down the window the dial scrolls. Keep it inside the conversation."
              value={String(settings.values.scroll.fromTop)}
              options={choiceOptions(
                [0.2, 0.3, 0.4, 0.5, 0.6],
                settings.values.scroll.fromTop,
                (fraction) => `${Math.round(fraction * 100)}% from the top`,
              )}
              disabled={settings.saving}
              onValueChange={(value) =>
                save({
                  ...settings.values,
                  scroll: { ...settings.values.scroll, fromTop: Number(value) },
                })
              }
            />
            <SettingsAction
              label="Restore the default actions"
              hint="Every key, the dial, and the joystick go back to their first actions."
              actionLabel="Restore"
              disabled={settings.saving}
              onPress={() => save({ ...settings.values, bindings: DEFAULT_SETTINGS.bindings })}
            />
          </SettingsCard>
          <ConnectionFields settings={settings} status={status} theme={theme} />
          <DetailsCard status={status} />
        </>
      ) : null}
    </SettingsSection>
  );
}

/** What each lower key's own light shows, which only some keypad layers allow. */
function KeyLightsCard({ settings, save }: { settings: ReadySettings; save: Save }) {
  const values = settings.values;
  const lights = values.lights;
  return (
    <SettingsCard>
      <SettingsRow
        label="Key lights"
        hint="What each key's own light shows. Only some keypad layers let a key have its own light; on others, the keys use the Other keys light."
      />
      {ACTION_KEYS.map((key) => (
        <SettingsSelect
          key={key}
          label={ACTION_INPUT_LABELS[key]}
          value={lights.actionKeys[key]}
          options={ACTION_KEY_LIGHT_OPTIONS}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({
              ...values,
              lights: {
                ...lights,
                actionKeys: { ...lights.actionKeys, [key]: value as ActionKeyLightSource },
              },
            })
          }
        />
      ))}
    </SettingsCard>
  );
}

function ConnectionFields({
  settings,
  status,
  theme,
}: {
  settings: ReadySettings;
  status: KeypadStatus | undefined;
  theme: PluginTheme;
}) {
  const reconnect = useRpc(reconnectRpc);
  const values = settings.values;
  const [draft, setDraft] = useState(values.connection);
  const [error, setError] = useState<string | null>(null);
  const changed = JSON.stringify(draft) !== JSON.stringify(values.connection);
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger, fontSize: 13 }), [theme]);
  const saveDraft = async () => {
    const parsed = SettingsSchema.safeParse({ ...values, connection: draft });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "These settings aren't valid.");
      return;
    }
    setError(null);
    await settings.save(parsed.data, settings.revision);
  };
  return (
    <>
      <SettingsCard>
        <SettingsInput
          label="Paseo command-line tool"
          hint="Leave empty to find it automatically."
          initialValue={values.connection.cliPath}
          placeholder="Automatic"
          disabled={settings.saving}
          onChangeText={(cliPath) => setDraft((current) => ({ ...current, cliPath }))}
        />
        <SettingsInput
          label="Paseo Micro address"
          hint="Leave empty to use the default."
          initialValue={values.connection.socketPath}
          placeholder="Default"
          disabled={settings.saving}
          onChangeText={(socketPath) => setDraft((current) => ({ ...current, socketPath }))}
        />
        <SettingsInput
          label="Paseo app bundle ID"
          hint="The app that receives keyboard shortcuts from the keypad."
          initialValue={values.connection.paseoBundleId}
          disabled={settings.saving}
          onChangeText={(paseoBundleId) => setDraft((current) => ({ ...current, paseoBundleId }))}
        />
        {changed ? (
          <SettingsAction
            label="Unsaved changes"
            actionLabel="Save"
            disabled={settings.saving}
            onPress={() => void saveDraft()}
          />
        ) : null}
        <SettingsAction
          label="Reconnect to Paseo Micro"
          hint={status?.bridge.error ?? undefined}
          actionLabel="Reconnect"
          onPress={() => void reconnect({})}
        />
      </SettingsCard>
      {error ? (
        <Text accessibilityRole="alert" style={errorStyle}>
          {error}
        </Text>
      ) : null}
    </>
  );
}

/** Technical details of the keypad and Paseo Micro, as the menu bar app shows them with Option. */
function DetailsCard({ status }: { status: KeypadStatus | undefined }) {
  const keypad = status?.keypad;
  const rows: [string, string][] = [];
  if (status?.bridge.appVersion) rows.push(["Paseo Micro", status.bridge.appVersion]);
  if (keypad?.firmware) rows.push(["Firmware", keypad.firmware]);
  if (keypad?.layer !== null && keypad?.layer !== undefined) {
    rows.push(["Layer", String(keypad.layer)]);
  }
  if (status?.lastInput) rows.push(["Last input", status.lastInput.description]);
  if (status?.lastAction) {
    rows.push([
      "Last action",
      `${ACTIONS[status.lastAction.action].label}: ${status.lastAction.message}`,
    ]);
  }
  if (rows.length === 0) return null;
  return (
    <SettingsCard>
      {rows.map(([label, value]) => (
        <SettingsRow key={label} label={label} hint={value} />
      ))}
    </SettingsCard>
  );
}
