import SwiftUI

/// The menu bar app that keeps the Creator Micro 2 session for Paseo.
@main
struct PaseoMicroApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: model)
        } label: {
            Image(nsImage: model.menuBarIcon.image)
                .opacity(model.menuBarIcon.opacity)
                .accessibilityLabel("Paseo Micro")
        }
        .menuBarExtraStyle(.window)
    }
}
