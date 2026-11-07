import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginIconProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SidebarRow,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { reconnectRpc, type KeypadStatus } from "../shared/rpc";
import {
  keypadSettings,
  LIGHT_SOURCE_LABELS,
  TOP_KEY_MODE_LABELS,
  TOP_KEY_MODES,
  UNDERGLOW_SOURCES,
  type KeypadSettings,
  type TopKeyMode,
  type UnderglowSource,
} from "../shared/settings";
import { KEYPAD_ICON } from "./keypad-icon";
import { KeypadPicture } from "./keypad-picture";
import { useKeypadStatus } from "./status";
import {
  ATTENTION_LABELS,
  connectionDetail,
  keypadWorks,
  sidebarLabel,
  summarize,
} from "./summary";

/** The keypad glyph, dimmed while the keypad does not work. */
function DimmedKeypadIcon({ size, color }: PluginIconProps) {
  return (
    <View style={{ opacity: 0.4 }}>
      <Icon icon={KEYPAD_ICON} size={size} color={color} />
    </View>
  );
}

/**
 * The color of the next agent that needs action, as the keypad's lights show its state,
 * or null when no agent needs action. Falls back to the theme's status colors
 * while the settings load or when a state's light is off.
 */
function attentionColor(
  status: KeypadStatus | undefined,
  lights: KeypadSettings["lights"] | null,
  theme: PluginTheme,
): string | null {
  const state = status?.nextAgent?.state;
  if (!state) return null;
  const style = lights?.[state];
  if (style && style.effect !== "off" && style.brightness > 0 && style.color !== "#000000") {
    return style.color;
  }
  return {
    failed: theme.colors.statusDanger,
    needsInput: theme.colors.statusWarning,
    done: theme.colors.statusSuccess,
  }[state];
}

/**
 * A sidebar footer row with the keypad glyph and, in a few words, the state of the agent
 * that key 7 opens next; the modal names the agent.
 * Its dot shows that agent's state in the keypad's colors, like the underglow;
 * there is no dot when nothing needs action, and the glyph dims while the keypad does not work.
 * A press opens a modal with the keypad and its most used settings.
 */
export function KeypadSidebarItem({
  theme,
  host,
  openSettings,
}: PluginSidebarItemProps & { openSettings: () => void }) {
  const status = useKeypadStatus(host.id);
  const settings = useSettings(keypadSettings);
  const [open, setOpen] = useState(false);
  const works = keypadWorks(status.data);
  const color = works
    ? attentionColor(
        status.data,
        settings.status === "ready" ? settings.values.lights : null,
        theme,
      )
    : null;
  return (
    <>
      <SidebarRow
        icon={works ? KEYPAD_ICON : DimmedKeypadIcon}
        label={sidebarLabel(status.data)}
        onPress={() => setOpen(true)}
        trailing={
          color ? (
            <View
              accessible={false}
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }}
            />
          ) : null
        }
      />
      <Modal
        title="Creator Micro"
        icon={<Icon icon={KEYPAD_ICON} size={16} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          {open ? (
            <KeypadModalBody
              theme={theme}
              status={status.data}
              refetch={() => void status.refetch()}
              openSettings={() => {
                setOpen(false);
                openSettings();
              }}
            />
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}

const TOP_KEY_OPTIONS = TOP_KEY_MODES.map((mode) => ({
  value: mode,
  label: TOP_KEY_MODE_LABELS[mode],
}));

const UNDERGLOW_OPTIONS = UNDERGLOW_SOURCES.map((source) => ({
  value: source,
  label: LIGHT_SOURCE_LABELS[source],
}));

/**
 * What a person can act on from the sidebar: the keypad's status when it does not work,
 * a live picture of the keypad, the two settings people change most, and the full settings.
 */
function KeypadModalBody({
  theme,
  status,
  refetch,
  openSettings,
}: {
  theme: PluginTheme;
  status: KeypadStatus | undefined;
  refetch: () => void;
  openSettings: () => void;
}) {
  const settings = useSettings(keypadSettings);
  const reconnect = useRpc(reconnectRpc);
  const works = keypadWorks(status);
  return (
    <>
      <SettingsCard>
        <SettingsRow
          label={summarize(status)}
          hint={
            status?.settings.error ??
            (status?.bridge.state === "waiting"
              ? "Paseo Micro is the menu bar app that connects your keypad to Paseo."
              : (connectionDetail(status) ?? undefined))
          }
        />
        {works && status?.nextAgent ? (
          <SettingsRow
            label={ATTENTION_LABELS[status.nextAgent.state]}
            hint={`${status.nextAgent.name}. Key 7 opens it.`}
          />
        ) : null}
        {status?.bridge.state === "waiting" ? (
          <SettingsAction
            label="Already open?"
            actionLabel="Reconnect"
            onPress={() => void reconnect({}).then(refetch)}
          />
        ) : null}
        {settings.status === "ready" ? (
          <View style={{ alignItems: "center", paddingVertical: 8 }}>
            <KeypadPicture
              theme={theme}
              settings={settings.values}
              status={works ? status : undefined}
              selection={null}
              legend={false}
            />
          </View>
        ) : null}
      </SettingsCard>
      {settings.status === "ready" ? (
        <SettingsCard>
          <SettingsSelect
            label="Top keys"
            value={settings.values.topKeys.mode}
            options={TOP_KEY_OPTIONS}
            disabled={settings.saving}
            onValueChange={(mode) =>
              void settings.save(
                {
                  ...settings.values,
                  topKeys: { ...settings.values.topKeys, mode: mode as TopKeyMode },
                },
                settings.revision,
              )
            }
          />
          <SettingsSelect
            label="Underglow"
            value={settings.values.lights.underglowSource}
            options={UNDERGLOW_OPTIONS}
            disabled={settings.saving}
            onValueChange={(source) =>
              void settings.save(
                {
                  ...settings.values,
                  lights: {
                    ...settings.values.lights,
                    underglowSource: source as UnderglowSource,
                  },
                },
                settings.revision,
              )
            }
          />
        </SettingsCard>
      ) : null}
      <SettingsCard>
        <SettingsAction
          label="Keys, dial, joystick, and lights"
          actionLabel="Open settings"
          onPress={openSettings}
        />
      </SettingsCard>
    </>
  );
}
