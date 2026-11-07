// Stand-ins for `@getpaseo/plugin/client/ui`, drawn after Paseo's settings screens:
// titled sections, rounded cards with dividers between rows, and a label and hint
// on the left of each row with its control on the right.
// They approximate Paseo's look for development; Paseo draws the real ones.
import type { PluginTheme } from "@getpaseo/plugin";
import { icons } from "lucide-react";
import { Children, createContext, Fragment, isValidElement, useContext, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, TextInput as NativeTextInput, View } from "react-native-web";

export const ThemeContext = createContext<PluginTheme | null>(null);

function useTheme(): PluginTheme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("No theme");
  return theme;
}

function pascal(name: string): string {
  return name
    .split(/[-_ ]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function Icon({ name, size = 16, color }: { name?: string; size?: number; color?: string }) {
  const Lucide = name ? (icons as Record<string, typeof icons.Circle>)[pascal(name)] : undefined;
  return Lucide ? <Lucide size={size} color={color} /> : null;
}

export function SettingsSection({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 12, marginBottom: 32 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

export function SettingsCard({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const items: ReactNode[] = [];
  const flatten = (nodes: ReactNode) =>
    Children.forEach(nodes, (child) => {
      if (isValidElement(child) && child.type === Fragment) {
        flatten((child.props as { children: ReactNode }).children);
      } else if (child !== null && child !== undefined && child !== false) {
        items.push(child);
      }
    });
  flatten(children);
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
      }}
    >
      {items.map((child, index) => (
        <View
          key={index}
          style={index > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.border } : null}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

interface RowProps {
  label: string;
  hint?: string;
  error?: string | null;
  children?: ReactNode;
}

function RowText({ label, hint, error }: RowProps) {
  const theme = useTheme();
  return (
    <View style={{ flexShrink: 1, flexGrow: 1, gap: 2 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{label}</Text>
      {hint ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>
      ) : null}
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
      ) : null}
    </View>
  );
}

const ROW = { paddingHorizontal: 16, paddingVertical: 12, gap: 12 } as const;

export function SettingsRow({ children, ...text }: RowProps) {
  return (
    <View style={ROW}>
      <RowText {...text} />
      {children}
    </View>
  );
}

function TrailingRow({ control, ...text }: RowProps & { control: ReactNode }) {
  return (
    <View style={[ROW, { flexDirection: "row", alignItems: "center" }]}>
      <RowText {...text} />
      {control}
    </View>
  );
}

export function SettingsSwitch({
  value,
  onValueChange,
  disabled,
  ...text
}: RowProps & { value: boolean; onValueChange(value: boolean): void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <TrailingRow
      {...text}
      control={
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: value, disabled }}
          disabled={disabled}
          onPress={() => onValueChange(!value)}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            padding: 2,
            backgroundColor: value ? theme.colors.accent : theme.colors.surface2,
            alignItems: value ? "flex-end" : "flex-start",
          }}
        >
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: "#fff" }} />
        </Pressable>
      }
    />
  );
}

export function SettingsSelect<Value extends string>({
  value,
  options,
  onValueChange,
  disabled,
  ...text
}: RowProps & {
  value: Value;
  options: readonly { label: string; value: Value }[];
  onValueChange(value: Value): void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <TrailingRow
      {...text}
      control={
        <select
          aria-label={text.label}
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value as Value)}
          style={{
            maxWidth: 260,
            background: theme.colors.surface2,
            color: theme.colors.foreground,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 8,
            padding: "6px 8px",
            fontSize: 13,
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

export function SettingsInput({
  initialValue,
  onChangeText,
  placeholder,
  disabled,
  ...text
}: RowProps & {
  initialValue?: string;
  onChangeText(text: string): void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [value, setValue] = useState(initialValue ?? "");
  return (
    <TrailingRow
      {...text}
      control={
        <NativeTextInput
          value={value}
          placeholder={placeholder}
          editable={!disabled}
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={(next: string) => {
            setValue(next);
            onChangeText(next);
          }}
          style={{
            width: 240,
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 6,
            fontSize: 13,
          }}
        />
      }
    />
  );
}

export function SettingsAction({
  actionLabel,
  onPress,
  disabled,
  ...text
}: RowProps & { actionLabel: string; onPress(): void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <TrailingRow
      {...text}
      control={
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onPress}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{actionLabel}</Text>
        </Pressable>
      }
    />
  );
}

export function SidebarRow({
  icon,
  label,
  onPress,
  trailing,
}: {
  icon?: string;
  label?: string;
  onPress(): void;
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderRadius: 6,
        }}
      >
        <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {label}
        </Text>
      </Pressable>
      {trailing}
    </View>
  );
}

export function useToast() {
  return {
    show: (message: string) => console.info("toast", message),
    error: (message: string) => console.error("toast", message),
  };
}
