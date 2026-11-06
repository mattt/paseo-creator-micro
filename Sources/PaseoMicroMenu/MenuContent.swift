import SwiftUI

/// The menu's content: the header, any warnings, the keypad, the Details section, and the items.
///
/// The view takes its state and sends its actions, so that it can draw without the app.
public struct MenuContent<DeveloperControls: View>: View {
    private let state: MenuState
    private let showsDetails: Bool
    private let onKeyTap: ((Int) -> Void)?
    private let perform: (MenuAction) -> Void
    private let developerControls: DeveloperControls

    /// The menu's width, in points.
    public static var width: CGFloat { 320 }

    /// Creates the content.
    ///
    /// - Parameters:
    ///   - state: What to show.
    ///   - showsDetails: Whether to show the Details section, as while Option is down.
    ///   - onKeyTap: Called when a key is clicked, or `nil` if keys are not clickable.
    ///   - perform: Called for each action.
    ///   - developerControls: Controls below the keypad, for development.
    public init(
        state: MenuState,
        showsDetails: Bool,
        onKeyTap: ((Int) -> Void)? = nil,
        perform: @escaping (MenuAction) -> Void,
        @ViewBuilder developerControls: () -> DeveloperControls
    ) {
        self.state = state
        self.showsDetails = showsDetails
        self.onKeyTap = onKeyTap
        self.perform = perform
        self.developerControls = developerControls()
    }

    /// The menu's content.
    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            ForEach(state.notices) { NoticeView(notice: $0, perform: perform) }
            KeypadView(
                lights: state.lights,
                lightableKeys: state.keypad.connected && state.keypad.isOnInputLayer
                    ? state.keypad.litKeysOnLayer : nil,
                connected: state.keypad.connected,
                showsKeyDetails: showsDetails,
                onTap: onKeyTap
            )
            if showsDetails {
                Divider()
                MenuDetailsView(state: state, perform: perform)
            }
            developerControls
            Divider()
            items
        }
        .padding(12)
        .frame(width: Self.width)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Paseo Micro").font(.headline)
                Text(state.statusText).font(.subheadline).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer()
            if let battery = state.battery {
                HStack(spacing: 4) {
                    Image(systemName: battery.symbolName)
                        .foregroundStyle(battery.isLow ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    Text(battery.text).monospacedDigit().foregroundStyle(.secondary)
                }
                .font(.subheadline)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(battery.accessibilityLabel)
            }
        }
    }

    private var items: some View {
        VStack(alignment: .leading, spacing: 0) {
            Toggle(
                "Launch at Login",
                isOn: Binding(get: { state.launchAtLogin }, set: { perform(.setLaunchAtLogin($0)) })
            )
            .toggleStyle(MenuItemToggleStyle())
            .disabled(!state.launchAtLoginAvailable)
            .help(state.launchAtLoginAvailable ? "" : "Move Paseo Micro to Applications to open it at login")
            Button("Open Paseo") { perform(.openPaseo) }
                .disabled(!state.paseoInstalled)
                .help(state.paseoInstalled ? "" : "Paseo is not installed")
            Divider().padding(.vertical, 4).padding(.horizontal, MenuItemButtonStyle.inset)
            Button("About Paseo Micro") { perform(.showAbout) }
            Button {
                perform(.quit)
            } label: {
                HStack {
                    Text("Quit Paseo Micro")
                    Spacer()
                    Text("⌘Q").foregroundStyle(.secondary).accessibilityHidden(true)
                }
            }
            .keyboardShortcut("q")
        }
        .buttonStyle(MenuItemButtonStyle())
        .padding(.horizontal, -MenuItemButtonStyle.inset)
    }
}

extension MenuContent where DeveloperControls == EmptyView {
    /// Creates the content without development controls.
    ///
    /// - Parameters:
    ///   - state: What to show.
    ///   - showsDetails: Whether to show the Details section, as while Option is down.
    ///   - perform: Called for each action.
    public init(state: MenuState, showsDetails: Bool, perform: @escaping (MenuAction) -> Void) {
        self.init(state: state, showsDetails: showsDetails, perform: perform) { EmptyView() }
    }
}

/// One warning, with its button if it has one.
private struct NoticeView: View {
    let notice: MenuNotice
    let perform: (MenuAction) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .symbolRenderingMode(.multicolor)
                .accessibilityLabel("Warning")
            VStack(alignment: .leading, spacing: 4) {
                Text(notice.message).fixedSize(horizontal: false, vertical: true)
                if let action = notice.action {
                    Button(action.title) { perform(action.action) }
                        .buttonStyle(NoticeButtonStyle())
                }
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
    }
}

/// The section that Option reveals.
private struct MenuDetailsView: View {
    let state: MenuState
    let perform: (MenuAction) -> Void

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Details").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
                ForEach(state.detailRows, id: \.title) { row in
                    GridRow {
                        Text(row.title).foregroundStyle(.secondary)
                        Text(row.value).lineLimit(3).textSelection(.enabled)
                    }
                    .accessibilityElement(children: .combine)
                }
                GridRow {
                    Text("MCP Address").foregroundStyle(.secondary)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(state.mcpText).lineLimit(3).textSelection(.enabled)
                        if let url = state.mcpURL { copyButton(url.absoluteString) }
                    }
                }
            }
            .font(.caption)
        }
    }

    private func copyButton(_ text: String) -> some View {
        Button {
            perform(.copy(text))
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Copy MCP Address")
        .accessibilityLabel(copied ? "Copied" : "Copy MCP Address")
    }
}
