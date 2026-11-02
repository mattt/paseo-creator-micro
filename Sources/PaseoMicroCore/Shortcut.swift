import CoreGraphics
import Foundation

/// A key combination for the bridge's `sendShortcut` command, such as `cmd+shift+d`.
///
/// A shortcut is `+`-joined modifiers (`cmd`, `shift`, `option`, `ctrl`)
/// and one key: a letter, a digit, `[`, `]`, `return`, `escape`, `space`, `tab`, or `f1` to `f20`.
/// Letters, digits, and brackets name key positions on the ANSI (US) layout.
/// Names are case-insensitive.
public struct Shortcut: Sendable, Hashable, CustomStringConvertible {
    /// A modifier key.
    public enum Modifier: String, Sendable, Hashable, CaseIterable, Comparable {
        /// The Command key, `cmd`.
        case command = "cmd"
        /// The Shift key, `shift`.
        case shift
        /// The Option key, `option`.
        case option
        /// The Control key, `ctrl`.
        case control = "ctrl"

        /// The event flag for the modifier.
        public var flag: CGEventFlags {
            switch self {
            case .command: .maskCommand
            case .shift: .maskShift
            case .option: .maskAlternate
            case .control: .maskControl
            }
        }

        public static func < (lhs: Self, rhs: Self) -> Bool {
            allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
        }
    }

    /// The modifiers held with the key.
    public var modifiers: Set<Modifier>
    /// The key's name, in lowercase, such as `d`, `return`, or `f5`.
    public var key: String
    /// The macOS virtual key code of the key.
    public var keyCode: CGKeyCode

    /// Parses a shortcut.
    ///
    /// - Parameter text: The shortcut, such as `cmd+d` or `return`.
    /// - Throws: ``ShortcutError`` if the text is empty, repeats a modifier,
    ///   names an unknown key, or has no key or more than one key.
    public init(_ text: String) throws {
        let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard !text.isEmpty, !parts.contains(where: \.isEmpty) else { throw ShortcutError.empty(text) }
        var modifiers: Set<Modifier> = []
        var key: (name: String, code: CGKeyCode)?
        for part in parts {
            if let modifier = Modifier(rawValue: part) {
                guard modifiers.insert(modifier).inserted else { throw ShortcutError.repeatedModifier(part) }
            } else if let code = Self.keyCodes[part] {
                guard key == nil else { throw ShortcutError.moreThanOneKey(text) }
                key = (part, code)
            } else {
                throw ShortcutError.unknownKey(part)
            }
        }
        guard let key else { throw ShortcutError.noKey(text) }
        self.modifiers = modifiers
        self.key = key.name
        self.keyCode = key.code
    }

    /// The event flags for the modifiers.
    public var flags: CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { $0.insert($1.flag) }
    }

    /// The shortcut in its canonical form, such as `cmd+shift+d`.
    public var description: String {
        (modifiers.sorted().map(\.rawValue) + [key]).joined(separator: "+")
    }

    // Virtual key codes from HIToolbox's Events.h (ANSI layout).
    static let keyCodes: [String: CGKeyCode] = {
        var codes: [String: CGKeyCode] = [
            "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
            "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
            "t": 0x11, "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28,
            "n": 0x2D, "m": 0x2E,
            "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A,
            "8": 0x1C, "0": 0x1D,
            "[": 0x21, "]": 0x1E,
            "return": 0x24, "tab": 0x30, "space": 0x31, "escape": 0x35,
        ]
        let functionKeys: [CGKeyCode] = [
            0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D,
            0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A,
        ]
        for (index, code) in functionKeys.enumerated() {
            codes["f\(index + 1)"] = code
        }
        return codes
    }()
}

/// Errors from parsing a ``Shortcut``.
public enum ShortcutError: Error, Sendable, Hashable, CustomStringConvertible {
    /// The shortcut, or one of its parts, is empty.
    case empty(String)
    /// A modifier appears twice.
    case repeatedModifier(String)
    /// A part is neither a modifier nor a known key.
    case unknownKey(String)
    /// The shortcut has only modifiers.
    case noKey(String)
    /// The shortcut has more than one key.
    case moreThanOneKey(String)

    public var description: String {
        switch self {
        case .empty(let text): "The shortcut \"\(text)\" is empty or has an empty part"
        case .repeatedModifier(let name): "The modifier \(name) appears twice"
        case .unknownKey(let name):
            "Unknown key \"\(name)\"; use cmd, shift, option, ctrl, and one letter, digit, [, ], return, escape, space, tab, or f1-f20"
        case .noKey(let text): "The shortcut \"\(text)\" has no key"
        case .moreThanOneKey(let text): "The shortcut \"\(text)\" has more than one key"
        }
    }
}
