import PaseoMicroCore
import Testing

@Suite("Shortcuts and links")
struct InterfaceTests {
    @Test(
        "Shortcuts parse into modifiers and one key",
        arguments: [
            ("cmd+d", "cmd+d", 0x02),
            ("CMD+Shift+D", "cmd+shift+d", 0x02),
            ("return", "return", 0x24),
            ("ctrl+option+escape", "option+ctrl+escape", 0x35),
            ("shift+space", "shift+space", 0x31),
            ("cmd+tab", "cmd+tab", 0x30),
            ("cmd+1", "cmd+1", 0x12),
            ("cmd+[", "cmd+[", 0x21),
            ("cmd+]", "cmd+]", 0x1E),
            ("f1", "f1", 0x7A),
            ("option+f20", "option+f20", 0x5A),
        ]
    )
    func parses(text: String, canonical: String, keyCode: Int) throws {
        let shortcut = try Shortcut(text)
        #expect(shortcut.description == canonical)
        #expect(Int(shortcut.keyCode) == keyCode)
    }

    @Test("Modifiers map to event flags")
    func flags() throws {
        let shortcut = try Shortcut("cmd+shift+option+ctrl+a")
        #expect(shortcut.flags == [.maskCommand, .maskShift, .maskAlternate, .maskControl])
        #expect(try Shortcut("a").flags.isEmpty)
    }

    @Test(
        "Bad shortcuts are refused",
        arguments: [
            ("", ShortcutError.empty("")),
            ("cmd+", .empty("cmd+")),
            ("cmd+cmd+d", .repeatedModifier("cmd")),
            ("cmd+shift", .noKey("cmd+shift")),
            ("cmd+d+e", .moreThanOneKey("cmd+d+e")),
            ("hyper+d", .unknownKey("hyper")),
            ("f21", .unknownKey("f21")),
            ("cmd+enter", .unknownKey("enter")),
            ("cmd+{", .unknownKey("{")),
        ]
    )
    func refuses(text: String, error: ShortcutError) {
        #expect(throws: error) { try Shortcut(text) }
    }

    @Test("Only paseo:// links are accepted")
    func links() throws {
        let link = "paseo://h/srv_1/agent/0b95b862-1"
        #expect(try PaseoLink.validate(link).absoluteString == link)
        #expect(try PaseoLink.validate("PASEO://h/x").scheme?.lowercased() == "paseo")
        for bad in ["https://example.com", "file:///etc/passwd", "paseo:", "javascript:alert(1)", "not a url", ""] {
            #expect(throws: InterfaceError.notPaseoURL(bad)) { try PaseoLink.validate(bad) }
        }
    }

    @Test("The ChatGPT app is recognized by bundle ID or path")
    func chatGPT() {
        #expect(ChatGPTDetector.isChatGPT(bundleIdentifier: "com.openai.chat", bundlePath: nil))
        #expect(
            ChatGPTDetector.isChatGPT(bundleIdentifier: "com.openai.other", bundlePath: "/Applications/ChatGPT.app")
        )
        #expect(ChatGPTDetector.isChatGPT(bundleIdentifier: nil, bundlePath: "/Applications/ChatGPT.app/"))
        #expect(!ChatGPTDetector.isChatGPT(bundleIdentifier: "sh.paseo.desktop", bundlePath: "/Applications/Paseo.app"))
        #expect(!ChatGPTDetector.isChatGPT(bundleIdentifier: nil, bundlePath: nil))
    }

    @Test("ChatGPT processes are tracked from launch and termination")
    func chatGPTProcesses() {
        var processes = ChatGPTProcesses()
        #expect(!processes.isRunning)
        processes.launched(processID: 10, bundleIdentifier: "sh.paseo.desktop", bundlePath: nil)
        #expect(!processes.isRunning)
        processes.launched(processID: 11, bundleIdentifier: "com.openai.chat", bundlePath: nil)
        processes.launched(processID: 12, bundleIdentifier: nil, bundlePath: "/Applications/ChatGPT.app")
        #expect(processes.processIDs == [11, 12])
        processes.terminated(processID: 11)
        #expect(processes.isRunning)
        processes.terminated(processID: 10)
        processes.terminated(processID: 12)
        #expect(!processes.isRunning)
    }
}
