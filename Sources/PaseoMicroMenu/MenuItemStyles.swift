import AppKit
import SwiftUI

/// A button that looks like a menu item: as wide as the menu, highlighted under the pointer.
public struct MenuItemButtonStyle: ButtonStyle {
    /// The space between the highlight's edge and the checkmark column.
    public static let inset: CGFloat = 6
    /// The width of the column for checkmarks, which every item leaves, as a menu does.
    public static let checkmarkColumn: CGFloat = 16

    /// Creates the style.
    public init() {}

    /// Creates the item's view.
    public func makeBody(configuration: Configuration) -> some View {
        Item(configuration: configuration)
    }

    private struct Item: View {
        let configuration: Configuration
        @State private var hovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let highlighted = isEnabled && (hovering || configuration.isPressed)
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, MenuItemButtonStyle.inset + MenuItemButtonStyle.checkmarkColumn)
                .padding(.trailing, MenuItemButtonStyle.inset)
                .padding(.vertical, 3)
                .foregroundStyle(foreground(highlighted: highlighted))
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(highlighted ? Color(nsColor: .selectedContentBackgroundColor) : .clear)
                )
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }

        private func foreground(highlighted: Bool) -> AnyShapeStyle {
            if highlighted { return AnyShapeStyle(Color(nsColor: .selectedMenuItemTextColor)) }
            return isEnabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary)
        }
    }
}

/// A toggle that looks like a menu item, with a checkmark while it is on.
public struct MenuItemToggleStyle: ToggleStyle {
    /// Creates the style.
    public init() {}

    /// Creates the item's view.
    public func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            configuration.label
                .overlay(alignment: .leading) {
                    if configuration.isOn {
                        Image(systemName: "checkmark")
                            .font(.caption.weight(.semibold))
                            .offset(x: -MenuItemButtonStyle.checkmarkColumn)
                    }
                }
        }
        .buttonStyle(MenuItemButtonStyle())
        .accessibilityRepresentation {
            Toggle(isOn: configuration.$isOn) { configuration.label }.toggleStyle(.switch)
        }
    }
}

/// The button of a warning: tinted text, without a border, at the size of the warning's text.
public struct NoticeButtonStyle: ButtonStyle {
    /// Creates the style.
    public init() {}

    /// Creates the button's view.
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.tint)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}
