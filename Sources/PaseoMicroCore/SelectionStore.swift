import Foundation
import Synchronization

/// The workspace that the Paseo plugin selected, which the app keeps for it.
///
/// `@getpaseo/plugin` gives the plugin's daemon code no storage that it can write,
/// so a plugin reload would lose its selection.
/// The app outlives plugin reloads: the plugin sends `setSelection` whenever its selection changes,
/// and the app returns the stored ID in each `hello`.
/// The store keeps one ID for all clients, in memory; the latest `setSelection` wins.
public final class SelectionStore: Sendable {
    /// The longest workspace ID that the store accepts, in UTF-8 bytes.
    public static let maximumLength = 256

    private let value = Mutex<String?>(nil)

    /// Creates an empty store.
    public init() {}

    /// The stored workspace ID, or `nil` when nothing is selected.
    public var workspaceID: String? {
        value.withLock { $0 }
    }

    /// Stores a workspace ID, or clears the store.
    ///
    /// - Parameter workspaceID: The ID, or `nil` to clear the selection.
    /// - Throws: ``SelectionError`` when the ID is empty, longer than ``maximumLength`` bytes,
    ///   or contains a control character; the stored ID stays as it was.
    public func set(_ workspaceID: String?) throws(SelectionError) {
        if let workspaceID { try Self.validate(workspaceID) }
        value.withLock { $0 = workspaceID }
    }

    /// Checks a workspace ID before the store keeps it.
    ///
    /// - Parameter workspaceID: The ID.
    /// - Throws: ``SelectionError`` when the ID is empty, too long, or contains a control character.
    public static func validate(_ workspaceID: String) throws(SelectionError) {
        guard !workspaceID.isEmpty else { throw .empty }
        guard workspaceID.utf8.count <= maximumLength else { throw .tooLong(workspaceID.utf8.count) }
        guard !workspaceID.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else {
            throw .controlCharacter
        }
    }
}

/// Why the app refused a workspace ID in `setSelection`.
public enum SelectionError: Error, Sendable, Hashable, CustomStringConvertible {
    /// The ID is empty.
    case empty
    /// The ID is longer than ``SelectionStore/maximumLength`` bytes; the value is its length.
    case tooLong(Int)
    /// The ID contains a control character, such as a newline.
    case controlCharacter

    public var description: String {
        switch self {
        case .empty: "The workspace ID is empty"
        case .tooLong(let length):
            "The workspace ID has \(length) bytes; the most is \(SelectionStore.maximumLength)"
        case .controlCharacter: "The workspace ID contains a control character"
        }
    }
}
