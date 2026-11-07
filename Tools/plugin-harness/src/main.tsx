// Renders the settings screen beside a sidebar with the plugin's footer row and its popover.
// Query parameters: theme=dark|light, mode=<top key mode>, radial=on|off,
// state=connected|idle|waiting|disconnected|layer, view=settings|sidebar.
import type { PluginTheme } from "@getpaseo/plugin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ScrollView, Text, View } from "react-native-web";
import { KeypadSettingsScreen } from "../../../Plugin/client/settings-screen";
import { KeypadPopover, KeypadSidebarItem } from "../../../Plugin/client/sidebar-status";
import { ThemeContext } from "./plugin-ui";

const params = new URLSearchParams(location.search);

const DARK: PluginTheme = {
  colors: {
    surface0: "#101012",
    surface1: "#18181b",
    surface2: "#232327",
    border: "#2c2c31",
    foreground: "#ececef",
    foregroundMuted: "#9a9aa3",
    accent: "#3b82f6",
    accentForeground: "#ffffff",
    statusSuccess: "#22c55e",
    statusWarning: "#f59e0b",
    statusDanger: "#ef4444",
  },
} as PluginTheme;

const LIGHT: PluginTheme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f7f7f8",
    surface2: "#ececef",
    border: "#e2e2e6",
    foreground: "#18181b",
    foregroundMuted: "#6b6b74",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    statusSuccess: "#16a34a",
    statusWarning: "#d97706",
    statusDanger: "#dc2626",
  },
} as PluginTheme;

const theme = params.get("theme") === "light" ? LIGHT : DARK;
const host = { id: "sample-host", label: "This Mac" };
const layout = { compact: false, platform: "web" as const };
const surface = { theme, host, layout };

function App() {
  const view = params.get("view") ?? "all";
  return (
    <View
      style={{ flexDirection: "row", minHeight: "100vh", backgroundColor: theme.colors.surface0 }}
    >
      {view !== "settings" ? (
        <View
          style={{
            width: 300,
            borderRightWidth: 1,
            borderRightColor: theme.colors.border,
            justifyContent: "flex-end",
            paddingVertical: 12,
            gap: 12,
          }}
        >
          <View
            style={{
              marginHorizontal: 8,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <KeypadPopover {...surface} close={() => undefined} openScreen={() => undefined} />
          </View>
          <KeypadSidebarItem
            {...surface}
            currentScreen={null}
            openScreen={() => undefined}
            openPopover={() => undefined}
          />
        </View>
      ) : null}
      {view !== "sidebar" ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: "center" }}>
          <View style={{ width: 680, paddingVertical: 32, paddingHorizontal: 24 }}>
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 20,
                fontWeight: "600",
                marginBottom: 24,
              }}
            >
              Creator Micro
            </Text>
            <KeypadSettingsScreen {...surface} />
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

// `click=<label>` presses, in order, the elements whose accessibility labels start with each label,
// separated by "|", so that screenshots can show a chosen part or an open section.
async function clickThrough() {
  for (const label of (params.get("click") ?? "").split("|").filter(Boolean)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const element = [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((node) =>
      node.getAttribute("aria-label")?.startsWith(label),
    );
    element?.click();
  }
}
void clickThrough();

const client = new QueryClient();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={client}>
      <ThemeContext.Provider value={theme}>
        <App />
      </ThemeContext.Provider>
    </QueryClientProvider>,
  );
}
