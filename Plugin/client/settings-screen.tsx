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
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTION_IDS, ACTIONS, type ActionId } from "../shared/actions";
import { groupOf, joinKeys } from "../shared/key-groups";
import {
  ACTION_INPUT_LABELS,
  ACTION_KEYS,
  actionKeyIndex,
  isActionKey,
  KEY_ROWS,
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
  type TargetFallback,
  type TopKeyMode,
  type UnderglowSource,
  type KeypadSettings,
  type LightEffect,
  type LightStyle,
} from "../shared/settings";
import { KeypadPicture, type PictureSelection } from "./keypad-picture";
import { RadialMenuEditor } from "./radial-menu-editor";
import { unpinKey } from "./pins";
import { useKeypadStatus } from "./status";
import { summarize, topKeyLabel } from "./summary";

type ReadySettings = Extract<SettingsState<typeof keypadSettings.schema>, { status: "ready" }>;

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

/** Why the keypad does not work, when the summary alone does not say. */
function statusHint(status: KeypadStatus | undefined, failed: boolean): string | undefined {
  if (failed) return "Keypad status isn't available.";
  return status?.settings.error ?? undefined;
}

export function KeypadSettingsScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(keypadSettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={textStyle}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Creator Micro">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore the default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
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
  const [selection, setSelection] = useState<PictureSelection>({ kind: "input", input: "ACT06" });
  const values = settings.values;
  const save = useCallback(
    (next: KeypadSettings) => void settings.save(next, settings.revision),
    [settings],
  );
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);

  return (
    <>
      <SettingsSection title="Keypad">
        <SettingsCard>
          <SettingsRow
            label={summarize(status.data)}
            hint={statusHint(status.data, status.error !== null)}
          />
          <SettingsRow label="Layout" hint="Choose a key, the dial, or the joystick to change it.">
            <KeypadPicture
              theme={theme}
              settings={values}
              status={status.data}
              selection={selection}
              onSelect={setSelection}
            />
          </SettingsRow>
        </SettingsCard>
        <TopKeysEditor settings={settings} save={save} />
        {selection.kind === "radialMenu" ? (
          <RadialMenuEditor theme={theme} settings={settings} status={status.data} save={save} />
        ) : selection.kind === "input" ? (
          <InputEditor
            key={selection.input}
            input={selection.input}
            settings={settings}
            save={save}
          />
        ) : (
          <TopKeyEditor slot={selection.key} status={status.data} settings={settings} save={save} />
        )}
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={errorStyle}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>
      <LightsSection settings={settings} save={save} />
      <AgentsSection settings={settings} save={save} />
      <ScrollSection settings={settings} save={save} />
      <PushToTalkSection settings={settings} save={save} />
      <AdvancedSection settings={settings} status={status.data} theme={theme} />
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

/** Switches that join a key with the key to its right, or separate the keys of a keycap. */
function KeycapEditor({
  input,
  settings,
  save,
}: {
  input: ActionInput;
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const group = groupOf(values.keyGroups, input).filter(isActionKey);
  const last = group.at(-1);
  if (last === undefined) return null;
  const right = keyToTheRight(last);
  return (
    <>
      {group.length > 1 ? (
        <SettingsSwitch
          label="One keycap"
          hint="A press of either key runs the action once."
          value={true}
          disabled={settings.saving}
          onValueChange={() =>
            save({
              ...values,
              keyGroups: values.keyGroups.filter((keys) => !keys.includes(last)),
            })
          }
        />
      ) : null}
      {right ? (
        <SettingsSwitch
          label={`One keycap with ${ACTION_INPUT_LABELS[right]}`}
          hint="For a double-wide keycap."
          value={false}
          disabled={settings.saving}
          onValueChange={() =>
            save({ ...values, keyGroups: joinKeys(values.keyGroups, last, right) })
          }
        />
      ) : null}
    </>
  );
}

function InputEditor({
  input,
  settings,
  save,
}: {
  input: ActionInput;
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const binding = values.bindings[input];
  const [prompt, setPrompt] = useState(binding.text);
  const setBinding = (next: { action: ActionId; text: string }) =>
    save({ ...values, bindings: { ...values.bindings, [input]: next } });
  const label = groupOf(values.keyGroups, input)
    .map((member) => ACTION_INPUT_LABELS[member])
    .join(" and ");
  return (
    <SettingsCard>
      <SettingsSelect
        label={label}
        hint={ACTIONS[binding.action].description}
        value={binding.action}
        options={ACTION_OPTIONS}
        disabled={settings.saving}
        onValueChange={(action) => setBinding({ ...binding, action })}
      />
      {binding.action === "sendPrompt" ? (
        <>
          <SettingsInput
            label="Prompt"
            hint="Sent to the selected workspace's agent."
            initialValue={binding.text}
            placeholder="Continue"
            disabled={settings.saving}
            onChangeText={setPrompt}
          />
          <SettingsAction
            label="Prompt changes"
            actionLabel="Save prompt"
            disabled={settings.saving || prompt === binding.text}
            onPress={() => setBinding({ ...binding, text: prompt })}
          />
        </>
      ) : null}
      <KeycapEditor input={input} settings={settings} save={save} />
      <SettingsAction
        label="Default actions"
        actionLabel="Restore"
        disabled={settings.saving}
        onPress={() => save({ ...values, bindings: DEFAULT_SETTINGS.bindings })}
      />
    </SettingsCard>
  );
}

/** The top keys' mode, and the tap option of the recent agents' keys. */
function TopKeysEditor({
  settings,
  save,
}: {
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const topKeys = values.topKeys;
  return (
    <SettingsCard>
      <SettingsSelect
        label="Top keys"
        hint={TOP_KEY_MODE_HINTS[topKeys.mode]}
        value={topKeys.mode}
        options={TOP_KEY_MODE_OPTIONS}
        disabled={settings.saving}
        onValueChange={(mode) =>
          save({ ...values, topKeys: { ...topKeys, mode: mode as TopKeyMode } })
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
    </SettingsCard>
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
      return `${description}${idle}`;
    }
    case "recentAgents":
      return `${describeKey(info, "agent")} ${openOnSingleTap ? "Tap to open." : "Tap to select; double-tap to open."}`;
    case "workspaces":
    case "pinned":
      return `${describeKey(info, "workspace")} Press to open. To pin a workspace, open it and run "Creator Micro: pin workspace to key ${slot + 1}" from the Command Center.`;
    case "off":
      return "The top keys are off. Choose another mode above.";
  }
}

function TopKeyEditor({
  slot,
  status,
  settings,
  save,
}: {
  slot: number;
  status: KeypadStatus | undefined;
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const { mode, openOnSingleTap } = settings.values.topKeys;
  const info = status?.keys[slot];
  const pinned = settings.values.pins[slot] ?? null;
  return (
    <SettingsCard>
      <SettingsRow
        label={`${keyName(slot)}: ${topKeyLabel(mode, slot, info)}`}
        hint={topKeyHint(mode, slot, info, openOnSingleTap)}
      />
      {pinned && (mode === "workspaces" || mode === "pinned") ? (
        <SettingsAction
          label={
            info?.workspaceId === pinned ? "Pinned to this key" : "Pinned workspace not available"
          }
          actionLabel="Unpin"
          disabled={settings.saving}
          onPress={() => save({ ...settings.values, pins: unpinKey(settings.values.pins, slot) })}
        />
      ) : null}
    </SettingsCard>
  );
}

function describeKey(
  info: KeypadStatus["keys"][number] | undefined,
  kind: "workspace" | "agent",
): string {
  if (!info) return "Unknown.";
  if (info.state === "empty") return kind === "agent" ? "No agent." : `${KEY_STATE_LABELS.empty}.`;
  if (kind === "agent") {
    return `${KEY_STATE_LABELS[info.state]}${info.project ? ` (${info.project})` : ""}.`;
  }
  const agents = info.agentCount === 1 ? "1 agent" : `${info.agentCount} agents`;
  const project = info.project ? `${info.project}, ` : "";
  return `${KEY_STATE_LABELS[info.state]} (${project}${agents}).`;
}

function LightStyleEditor({
  label,
  style,
  disabled,
  onChange,
}: {
  label: string;
  style: LightStyle;
  disabled: boolean;
  onChange: (style: LightStyle) => void;
}) {
  const [colorError, setColorError] = useState<string | null>(null);
  const changeColor = (text: string) => {
    const parsed = ColorSchema.safeParse(text);
    if (!parsed.success) {
      setColorError("Enter a color as #RRGGBB");
      return;
    }
    setColorError(null);
    if (parsed.data !== style.color) onChange({ ...style, color: parsed.data });
  };
  return (
    <SettingsCard>
      <SettingsInput
        label={`${label} color`}
        initialValue={style.color}
        placeholder="#RRGGBB"
        error={colorError}
        disabled={disabled}
        onChangeText={changeColor}
      />
      <SettingsSelect
        label={`${label} effect`}
        value={style.effect}
        options={EFFECT_OPTIONS}
        disabled={disabled}
        onValueChange={(effect) => onChange({ ...style, effect })}
      />
      <SettingsSelect
        label={`${label} brightness`}
        value={String(style.brightness)}
        options={percentOptions(style.brightness)}
        disabled={disabled}
        onValueChange={(value) => onChange({ ...style, brightness: Number(value) })}
      />
    </SettingsCard>
  );
}

function LightsSection({
  settings,
  save,
}: {
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const lights = values.lights;
  const setLights = (next: Partial<KeypadSettings["lights"]>) =>
    save({ ...values, lights: { ...lights, ...next } });
  return (
    <SettingsSection title="Lights">
      <SettingsCard>
        <SettingsRow
          label="Top keys"
          hint="Each key shows the state of its agent or the most urgent agent in its workspace. The selected key is brighter."
        />
        <SettingsSelect
          label="Selected workspace brightness"
          value={String(lights.selectedBrightness)}
          options={choiceOptions([1, 1.5, 2, 3, 4], lights.selectedBrightness, (v) => `${v}×`)}
          disabled={settings.saving}
          onValueChange={(value) => setLights({ selectedBrightness: Number(value) })}
        />
        <SettingsSelect
          label="Underglow"
          hint="What the light under the keypad shows."
          value={lights.underglowSource}
          options={UNDERGLOW_OPTIONS}
          disabled={settings.saving}
          onValueChange={(value) => setLights({ underglowSource: value as UnderglowSource })}
        />
      </SettingsCard>
      <LightStyleEditor
        label="Underglow while an agent needs input"
        style={lights.underglowStyle}
        disabled={settings.saving || lights.underglowSource !== "anyNeedsInput"}
        onChange={(underglowStyle) => setLights({ underglowStyle })}
      />
      <SettingsCard>
        <SettingsRow
          label="Action key lights"
          hint="What each key's own light shows, on keypad layers that give it one."
        />
        {ACTION_KEYS.map((key) => (
          <SettingsSelect
            key={key}
            label={ACTION_INPUT_LABELS[key]}
            value={lights.actionKeys[key]}
            options={ACTION_KEY_LIGHT_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) =>
              setLights({
                actionKeys: { ...lights.actionKeys, [key]: value as ActionKeyLightSource },
              })
            }
          />
        ))}
      </SettingsCard>
      {KEY_STATES.map((state) => (
        <LightStyleEditor
          key={state}
          label={KEY_STATE_LABELS[state]}
          style={lights[state]}
          disabled={settings.saving}
          onChange={(style) => setLights({ [state]: style })}
        />
      ))}
      <LightStyleEditor
        label="Selected, otherwise off"
        style={lights.selectedOff}
        disabled={settings.saving}
        onChange={(selectedOff) => setLights({ selectedOff })}
      />
      <LightStyleEditor
        label="Navigation key that can act"
        style={lights.navigation}
        disabled={settings.saving}
        onChange={(navigation) => setLights({ navigation })}
      />
      <LightStyleEditor
        label="Other keys"
        style={lights.keysZone}
        disabled={settings.saving}
        onChange={(keysZone) => setLights({ keysZone })}
      />
      <SettingsCard>
        <SettingsRow
          label="Thinking meter"
          hint="After a thinking change, the top keys show the new level for a moment."
        />
      </SettingsCard>
      <LightStyleEditor
        label="Thinking meter"
        style={lights.meter}
        disabled={settings.saving}
        onChange={(meter) => setLights({ meter })}
      />
      <LightStyleEditor
        label="Thinking meter, unlit"
        style={lights.meterOff}
        disabled={settings.saving}
        onChange={(meterOff) => setLights({ meterOff })}
      />
      <LightStyleEditor
        label="Thinking change failed"
        style={lights.failure}
        disabled={settings.saving}
        onChange={(failure) => setLights({ failure })}
      />
    </SettingsSection>
  );
}

function AgentsSection({
  settings,
  save,
}: {
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSwitch
          label="Include subagents"
          hint="Treat agents that other agents start like your own."
          value={values.agents.includeSubagents}
          disabled={settings.saving}
          onValueChange={(includeSubagents) =>
            save({ ...values, agents: { ...values.agents, includeSubagents } })
          }
        />
        <SettingsSelect
          label="Without a selected workspace"
          hint="The agent that actions use while no workspace is selected."
          value={values.targets.fallback}
          options={TARGET_FALLBACK_OPTIONS}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, targets: { ...values.targets, fallback: value as TargetFallback } })
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ScrollSection({
  settings,
  save,
}: {
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const scroll = values.scroll;
  return (
    <SettingsSection title="Scrolling">
      <SettingsCard>
        <SettingsSelect
          label="Lines per dial step"
          hint="How far one dial step scrolls."
          value={String(scroll.lines)}
          options={choiceOptions([1, 2, 3, 4, 5, 6, 8, 10], scroll.lines, (lines) =>
            lines === 1 ? "1 line" : `${lines} lines`,
          )}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, scroll: { ...scroll, lines: Number(value) } })
          }
        />
        <SettingsSelect
          label="Lines per fast step"
          hint="How far one step of the held dial scrolls."
          value={String(scroll.fastLines)}
          options={choiceOptions([5, 10, 15, 20, 30, 40, 60], scroll.fastLines, (lines) =>
            lines === 1 ? "1 line" : `${lines} lines`,
          )}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, scroll: { ...scroll, fastLines: Number(value) } })
          }
        />
        <SettingsSelect
          label="Scroll position"
          hint="Where the scroll happens. Keep it inside the conversation."
          value={String(scroll.fromTop)}
          options={choiceOptions(
            [0.2, 0.3, 0.4, 0.5, 0.6],
            scroll.fromTop,
            (fraction) => `${Math.round(fraction * 100)}% from the top`,
          )}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, scroll: { ...scroll, fromTop: Number(value) } })
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function PushToTalkSection({
  settings,
  save,
}: {
  settings: ReadySettings;
  save: (values: KeypadSettings) => void;
}) {
  const values = settings.values;
  const pushToTalk = values.pushToTalk;
  return (
    <SettingsSection title="Push to talk">
      <SettingsCard>
        <SettingsSwitch
          label="Send the dictation on release"
          hint="Press Return after dictation stops."
          value={pushToTalk.sendReturnOnRelease}
          disabled={settings.saving}
          onValueChange={(sendReturnOnRelease) =>
            save({ ...values, pushToTalk: { ...pushToTalk, sendReturnOnRelease } })
          }
        />
        <SettingsSelect
          label="Wait before Return"
          hint="Time for the text to reach the composer."
          value={String(pushToTalk.returnDelayMs)}
          options={choiceOptions(
            [0, 250, 400, 600, 800, 1000, 1500, 2000, 3000],
            pushToTalk.returnDelayMs,
            (ms) => `${ms} ms`,
          )}
          disabled={settings.saving}
          onValueChange={(value) =>
            save({ ...values, pushToTalk: { ...pushToTalk, returnDelayMs: Number(value) } })
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** Connection settings that most people never change, collapsed until asked for. */
function AdvancedSection({
  settings,
  status,
  theme,
}: {
  settings: ReadySettings;
  status: KeypadStatus | undefined;
  theme: PluginTheme;
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
      {open ? <ConnectionFields settings={settings} status={status} theme={theme} /> : null}
    </SettingsSection>
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
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);
  const saveDraft = async () => {
    const parsed = SettingsSchema.safeParse({ ...values, connection: draft });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "These settings are not valid");
      return;
    }
    setError(null);
    await settings.save(parsed.data, settings.revision);
  };
  return (
    <>
      <SettingsCard>
        <SettingsInput
          label="Paseo CLI"
          hint="Leave empty to find it automatically."
          initialValue={values.connection.cliPath}
          placeholder="/Applications/Paseo.app/Contents/Resources/bin/paseo"
          disabled={settings.saving}
          onChangeText={(cliPath) => setDraft((current) => ({ ...current, cliPath }))}
        />
        <SettingsInput
          label="Keypad app socket"
          hint="Leave empty for the default."
          initialValue={values.connection.socketPath}
          placeholder="~/Library/Application Support/PaseoMicro/bridge.sock"
          disabled={settings.saving}
          onChangeText={(socketPath) => setDraft((current) => ({ ...current, socketPath }))}
        />
        <SettingsInput
          label="Paseo app bundle ID"
          hint="The app that receives shortcuts."
          initialValue={values.connection.paseoBundleId}
          disabled={settings.saving}
          onChangeText={(paseoBundleId) => setDraft((current) => ({ ...current, paseoBundleId }))}
        />
        <SettingsAction
          label="Connection changes"
          actionLabel="Save"
          disabled={settings.saving || !changed}
          onPress={() => void saveDraft()}
        />
        <SettingsAction
          label="Connect to the keypad app now"
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
