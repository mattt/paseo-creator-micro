import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { ACTION_IDS, ACTIONS, type ActionId } from "../shared/actions";
import { groupOf, joinKeys } from "../shared/key-groups";
import {
  ACTION_INPUT_LABELS,
  ACTION_KEYS,
  actionKeyIndex,
  isActionKey,
  KEY_ROWS,
  keyActionInput,
  keyCode,
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
import { inputLayerList, offInputLayer, summarize, topKeyLabel } from "./summary";

type ReadySettings = Extract<SettingsState<typeof keypadSettings.schema>, { status: "ready" }>;

const ACTION_OPTIONS = ACTION_IDS.map((id) => ({ value: id, label: ACTIONS[id].label }));

const TOP_KEY_MODE_OPTIONS = TOP_KEY_MODES.map((mode) => ({
  value: mode,
  label: TOP_KEY_MODE_LABELS[mode],
}));

/** What each top-key mode does, for the mode picker's hint. */
const TOP_KEY_MODE_HINTS: Readonly<Record<TopKeyMode, string>> = {
  navigation:
    "Keys 1 and 2 go back and forward through the places that the keypad opened, key 3 opens the previous project, keys 4 and 5 send Cmd+[ and Cmd+] for Paseo's previous and next workspace, and key 6 opens the next project. A key is dim white while it can act and off when it cannot.",
  recentAgents:
    "The six most recently active agents, each in the color of its state. A tap selects the agent and its workspace; a double tap opens it and brings Paseo to the front.",
  workspaces:
    "The six most recently active workspaces, each in the color of its agents' most urgent state. A press opens the workspace's agent.",
  pinned:
    "Only the workspaces that you pinned to keys, in the color of their agents' most urgent state. The other keys are dark and do nothing.",
  off: "The six top keys are dark and do nothing.",
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

function statusHint(status: KeypadStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (status.settings.error) {
    return `Keypad actions are off. ${status.settings.error}`;
  }
  const { bridge, keypad } = status;
  if (bridge.state !== "connected") {
    return `Start the PaseoMicro app. The plugin retries ${bridge.socketPath}${bridge.error ? ` (${bridge.error})` : ""}.`;
  }
  if (!keypad?.connected) return "The keypad app is running but has no keypad.";
  const parts = [
    keypad.firmware && `firmware ${keypad.firmware}`,
    keypad.transport,
    keypad.battery !== null && `battery ${keypad.battery}%${keypad.charging ? ", charging" : ""}`,
    keypad.layer !== null && `layer ${keypad.layer}`,
  ].filter(Boolean);
  if (offInputLayer(keypad)) {
    parts.push(`workspace lights and inputs need ${inputLayerList(keypad.inputLayers)}`);
  } else if (keypad.layer !== null) {
    parts.push("a Paseo layer");
  }
  return parts.join(" · ");
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
            hint={status.error ? String(status.error) : statusHint(status.data)}
          />
          <SettingsRow
            label="Layout"
            hint="Choose a key, the dial, the joystick's radial menu, or a joystick direction to change it."
          >
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
      <ConnectionSection settings={settings} theme={theme} />
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
          hint="The keys act as one: a press of either key, or both, runs the action once, and it ends when the last key is released."
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
          hint="For a double-wide keycap over this key and the key to its right."
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
            hint="Sent to the selected workspace's agent. With no prompt, the input does nothing."
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
        label="Default actions for every input"
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
          hint="Open an agent and bring Paseo to the front with one tap of its key, instead of selecting it with one tap and opening it with two."
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
      const idle = info && !info.enabled ? " It has nothing to do now, so its light is off." : "";
      return `${description}${idle}`;
    }
    case "recentAgents":
      return `${describeKey(info, "agent")} A tap selects the agent and its workspace; ${openOnSingleTap ? "it also opens the agent" : "a double tap opens it"} and brings Paseo to the front.`;
    case "workspaces":
    case "pinned":
      return `${describeKey(info, "workspace")} Pressing the key selects the workspace and opens its agent that needs input, else its agent that failed, else its most recently active agent. To pin a workspace here, run "Creator Micro: pin workspace to key ${slot + 1}" from the Command Center while the workspace is open.`;
    case "off":
      return "The top keys are off. Choose another mode for them above.";
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
        label={`${keyCode(slot)}: ${topKeyLabel(mode, slot, info)}`}
        hint={topKeyHint(mode, slot, info, openOnSingleTap)}
      />
      {pinned && (mode === "workspaces" || mode === "pinned") ? (
        <SettingsAction
          label={
            info?.workspaceId === pinned
              ? "Pinned to this key"
              : "Pinned workspace is not available"
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
          hint="With workspaces on the top keys, each key shows the most urgent state of its workspace's agents: failed, then needs input, running, done with an unread result, and idle. With recent agents, each key shows its agent's state. The selected workspace's or agent's key is brighter, and it shows the selected-off light when its key would be off. In the navigation mode, a key shows the navigation light while it can act."
        />
        <SettingsSelect
          label="Selected workspace brightness"
          hint="Multiplies the brightness of the selected workspace's key."
          value={String(lights.selectedBrightness)}
          options={choiceOptions([1, 1.5, 2, 3, 4], lights.selectedBrightness, (v) => `${v}×`)}
          disabled={settings.saving}
          onValueChange={(value) => setLights({ selectedBrightness: Number(value) })}
        />
        <SettingsSelect
          label="Underglow"
          hint="Next agent that needs action: the state of the agent that the next-agent key would open next, in the failed, needs-input, and done colors, and off when no agent needs action. While any agent needs input: the underglow light below, off otherwise."
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
          hint="What each action key's own light shows. Next agent that needs action uses the failed, needs-input, and done colors, and is off when no agent needs action. A key lights only on a keypad layer that binds it to an AG code, such as KV_OAI_AG06; elsewhere it shows the other keys' light."
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
          hint="After a thinking change, the workspace keys show the agent's new level for a moment: one lit key for each step, out of six. When a thinking change fails, they flash the failure light instead."
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
          hint="Treat agents that other agents started like your own: the next-agent key, a workspace's actions, and its failed, needs-input, and done colors use them. When this is off, a subagent only lights its workspace's key while it runs."
          value={values.agents.includeSubagents}
          disabled={settings.saving}
          onValueChange={(includeSubagents) =>
            save({ ...values, agents: { ...values.agents, includeSubagents } })
          }
        />
        <SettingsSelect
          label="Without a selected workspace"
          hint="The agent that the radial menu, the joystick's prompts, and the other actions on the selected workspace's agent use while no workspace is selected. Next agent that needs action is the agent that the next-agent key would open next, else the most recently active agent; it does not select a workspace."
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
          hint="How far one step of the dial, or one press of a scroll input, scrolls the open conversation."
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
          hint="How far one step of the held dial, or one press of a fast scroll input, scrolls the open conversation."
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
          hint="Where in Paseo's window the scroll happens, from its top edge. It must be inside the conversation, above the composer."
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
          hint="After Cmd+D stops dictation, press Return to send the text."
          value={pushToTalk.sendReturnOnRelease}
          disabled={settings.saving}
          onValueChange={(sendReturnOnRelease) =>
            save({ ...values, pushToTalk: { ...pushToTalk, sendReturnOnRelease } })
          }
        />
        <SettingsSelect
          label="Wait before Return"
          hint="Time for the transcription to reach the composer after dictation stops, on release or when submit stops it."
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

function ConnectionSection({ settings, theme }: { settings: ReadySettings; theme: PluginTheme }) {
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
    <SettingsSection title="Connection">
      <SettingsCard>
        <SettingsInput
          label="Paseo CLI"
          hint="Empty to use paseo on PATH, then the copy in Paseo.app."
          initialValue={values.connection.cliPath}
          placeholder="/Applications/Paseo.app/Contents/Resources/bin/paseo"
          disabled={settings.saving}
          onChangeText={(cliPath) => setDraft((current) => ({ ...current, cliPath }))}
        />
        <SettingsInput
          label="Keypad app socket"
          hint="Empty for ~/Library/Application Support/PaseoMicro/bridge.sock."
          initialValue={values.connection.socketPath}
          placeholder="~/Library/Application Support/PaseoMicro/bridge.sock"
          disabled={settings.saving}
          onChangeText={(socketPath) => setDraft((current) => ({ ...current, socketPath }))}
        />
        <SettingsInput
          label="Paseo app bundle ID"
          hint="The app that receives Cmd+D and the other shortcuts."
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
          actionLabel="Reconnect"
          onPress={() => void reconnect({})}
        />
      </SettingsCard>
      {error ? (
        <Text accessibilityRole="alert" style={errorStyle}>
          {error}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
