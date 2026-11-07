import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WORKSPACE_KEY_COUNT } from "./shared/keypad";
import { reconnectRpc, statusRpc } from "./shared/rpc";
import { changePins, parseKeyNumber, pinWorkspace, unpinWorkspace } from "./client/pins";
import { KeypadSettingsScreen } from "./client/settings-screen";
import { KeypadSidebarItem } from "./client/sidebar-status";

const SETTINGS_SCREEN = "keypad";

export default function contribute(client: PluginClientContext) {
  // The daemon code gets its Paseo connection from the first RPC or hook that runs,
  // so ask for the status as soon as this app connects.
  void client.rpc(statusRpc, {}).catch(() => undefined);

  const removers = [
    client.addSettingsScreen({
      id: SETTINGS_SCREEN,
      title: "Keypad",
      icon: "Keyboard",
      Component: KeypadSettingsScreen,
    }),
    client.addSidebarFooterItem({
      id: "keypad-status",
      title: "Keypad",
      Component: KeypadSidebarItem,
    }),
    client.addCommandCenterItem({
      id: "open-settings",
      title: "Creator Micro: open keypad settings",
      icon: "Keyboard",
      keywords: ["keypad", "work louder", "creator micro", "keys"],
      context: "global",
      onSelect: ({ openSettings }) => openSettings(SETTINGS_SCREEN),
    }),
    client.addCommandCenterItem({
      id: "reconnect",
      title: "Creator Micro: reconnect to Paseo Micro",
      icon: "RefreshCw",
      keywords: ["keypad", "reconnect", "paseo micro"],
      context: "global",
      onSelect: async ({ rpc }) => {
        await rpc(reconnectRpc, {});
      },
    }),
    client.addCommandCenterItem({
      id: "unpin-all",
      title: "Creator Micro: unpin all keys",
      icon: "PinOff",
      keywords: ["keypad", "pin"],
      context: "global",
      onSelect: ({ rpc }) => changePins(rpc, (pins) => pins.map(() => null)),
    }),
    ...Array.from({ length: WORKSPACE_KEY_COUNT }, (_, slot) =>
      client.addCommandCenterItem({
        id: `pin-workspace-key-${slot + 1}`,
        title: `Creator Micro: pin workspace to key ${slot + 1}`,
        icon: "Pin",
        keywords: ["keypad", "pin", "workspace", `key ${slot + 1}`],
        context: "workspace",
        onSelect: ({ rpc, workspace }) =>
          changePins(rpc, (pins) => pinWorkspace(pins, workspace.id, slot)),
      }),
    ),
    client.addCommandCenterItem({
      id: "unpin-workspace",
      title: "Creator Micro: unpin workspace",
      icon: "PinOff",
      keywords: ["keypad", "pin", "workspace"],
      context: "workspace",
      onSelect: ({ rpc, workspace }) =>
        changePins(rpc, (pins) => unpinWorkspace(pins, workspace.id)),
    }),
    client.addSlashCommand({
      name: "keypad-pin-workspace",
      description: "Pin this agent's workspace to a Creator Micro top key",
      argumentHint: "<1-6>",
      context: "agent",
      onSubmit: ({ rpc, agent, args }) => {
        const slot = parseKeyNumber(args);
        return changePins(rpc, (pins) => pinWorkspace(pins, agent.workspaceId, slot));
      },
    }),
    client.addSlashCommand({
      name: "keypad-unpin-workspace",
      description: "Unpin this agent's workspace from the Creator Micro",
      argumentHint: "",
      context: "agent",
      onSubmit: ({ rpc, agent }) =>
        changePins(rpc, (pins) => unpinWorkspace(pins, agent.workspaceId)),
    }),
  ];

  return () => {
    for (const remove of removers) void remove();
  };
}
