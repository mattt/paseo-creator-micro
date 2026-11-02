import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTIONS } from "../shared/actions";
import { keyCode } from "../shared/keypad";
import { reconnectRpc } from "../shared/rpc";
import { KEY_STATE_LABELS } from "../shared/settings";
import { useKeypadStatus } from "./status";
import { lightSwatch, summarize, topKeyLabel } from "./summary";

/** A sidebar footer row that shows whether the keypad works and opens its details. */
export function KeypadSidebarItem({ theme, host, openPopover }: PluginSidebarItemProps) {
  const status = useKeypadStatus(host.id);
  const dot = lightSwatch(status.data?.ambient, theme.colors.border);
  return (
    <SidebarRow
      icon="Keyboard"
      label={summarize(status.data)}
      onPress={() => openPopover(KeypadPopover)}
      trailing={
        <View
          accessibilityLabel="Underglow: lit while an agent needs input"
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }}
        />
      }
    />
  );
}

function KeypadPopover({ theme, host }: PluginPopoverProps) {
  const status = useKeypadStatus(host.id);
  const reconnect = useRpc(reconnectRpc);
  const styles = useMemo(
    () => ({
      body: { padding: 16, gap: 8, minWidth: 280 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      text: { color: theme.colors.foreground, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      swatch: { width: 10, height: 10, borderRadius: 2 },
      button: {
        marginTop: 4,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        alignSelf: "flex-start" as const,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 13 },
    }),
    [theme],
  );
  const data = status.data;
  return (
    <View style={styles.body}>
      <Text style={styles.title}>{summarize(data)}</Text>
      {data?.settings.error ? <Text style={styles.muted}>{data.settings.error}</Text> : null}
      {data?.bridge.state !== "connected" && data?.bridge.error ? (
        <Text style={styles.muted}>{data.bridge.error}</Text>
      ) : null}
      {data?.keys.map((key) => (
        <View key={key.key} style={styles.row}>
          <View
            style={[
              styles.swatch,
              { backgroundColor: lightSwatch(key.light, theme.colors.surface2) },
            ]}
          />
          <Text style={styles.text} numberOfLines={1}>
            {keyCode(key.key)} {topKeyLabel(data.topKeyMode, key.key, key)}
            {key.kind === "navigation" && !key.enabled ? " · nothing to do" : ""}
            {key.state !== "empty" ? ` · ${KEY_STATE_LABELS[key.state]}` : ""}
            {key.selected ? " · selected" : ""}
            {key.pinned ? " · pinned" : ""}
          </Text>
        </View>
      ))}
      {data?.lastInput ? (
        <Text style={styles.muted}>Last input: {data.lastInput.description}</Text>
      ) : null}
      {data?.lastAction ? (
        <Text style={styles.muted}>
          {ACTIONS[data.lastAction.action].label}: {data.lastAction.message}
        </Text>
      ) : null}
      <Text style={styles.muted}>Change the keys in Settings › Plugins › Creator Micro.</Text>
      {data?.bridge.state === "waiting" ? (
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() => void reconnect({}).then(() => status.refetch())}
        >
          <Text style={styles.buttonText}>Reconnect</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
