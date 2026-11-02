import CreatorMicro
import Testing

@Suite("Report framing")
struct ReportTests {
    @Test("Short messages fit in one report with ID, channel, and length")
    func singleReport() {
        let reports = Report.reports(for: Array("{}".utf8), channel: .rpc)
        #expect(reports.count == 1)
        let report = reports[0]
        #expect(report.count == 64)
        #expect(Array(report.prefix(5)) == [0x06, 2, 2, UInt8(ascii: "{"), UInt8(ascii: "}")])
        #expect(report.dropFirst(5).allSatisfy { $0 == 0 })
    }

    @Test("Long messages split into 61-byte payloads")
    func split() throws {
        let message = Array(String(repeating: "x", count: 150).utf8)
        let reports = Report.reports(for: message)
        #expect(reports.count == 3)
        let frames = try reports.map { try #require(Report.Frame(report: $0)) }
        #expect(frames.map(\.payload.count) == [61, 61, 28])
        #expect(frames.flatMap(\.payload) == message)
    }

    @Test("A message of exactly 61 bytes takes one report", arguments: [61, 122])
    func exactMultiple(length: Int) {
        let reports = Report.reports(for: [UInt8](repeating: 0x41, count: length))
        #expect(reports.count == length / 61)
    }

    @Test("JSON-RPC messages go out wrapped in CRLF")
    func rpcWrapping() throws {
        let json = Array(#"{"method":"sys.version","id":1}"#.utf8)
        let reports = Report.rpcReports(for: json)
        let payload = try reports.flatMap { try #require(Report.Frame(report: $0)).payload }
        #expect(payload == Array("\r\n".utf8) + json + Array("\r\n".utf8))
        #expect(reports.allSatisfy { $0[1] == Report.Channel.rpc.rawValue })
    }

    @Test("Malformed reports do not decode")
    func malformed() {
        #expect(Report.Frame(report: []) == nil)
        #expect(Report.Frame(report: [0x05, 2, 0]) == nil)
        #expect(Report.Frame(report: [0x06, 9, 0]) == nil)
        #expect(Report.Frame(report: [0x06, 2, 5, 1, 2]) == nil)
        #expect(Report.Frame(report: [0x06, 2, 62] + [UInt8](repeating: 0, count: 62)) == nil)
    }

    @Test("A frame round-trips through its report")
    func roundTrip() {
        let frame = Report.Frame(channel: .debug, payload: Array("hello".utf8))
        #expect(Report.Frame(report: frame.report) == frame)
    }
}

@Suite("Message reassembly")
struct ReassemblyTests {
    private func reassemble(_ chunks: [String]) -> [String] {
        var reassembler = MessageReassembler()
        return chunks.flatMap { reassembler.append(Array($0.utf8)) }.map { String(decoding: $0, as: UTF8.self) }
    }

    @Test("Joins an object split across reports")
    func splitObject() {
        #expect(
            reassemble([#"{"id":1,"res"#, #"ult":{"ver"#, #"sion":"0.6.3"}}"#]) == [
                #"{"id":1,"result":{"version":"0.6.3"}}"#
            ]
        )
    }

    @Test("Separates objects merged in one report")
    func mergedObjects() {
        #expect(
            reassemble([#"{"m":"a"}\#r\#n{"m":"b"}{"m""#, #":"c"}"#]) == [
                #"{"m":"a"}"#, #"{"m":"b"}"#, #"{"m":"c"}"#,
            ]
        )
    }

    @Test("Ignores braces inside strings, including escaped quotes")
    func bracesInStrings() {
        let object = #"{"data":"{\"a\":\"}}\\\"{\"}","n":{"x":"}"}}"#
        #expect(reassemble([String(object.prefix(10)), String(object.dropFirst(10))]) == [object])
    }

    @Test("Drops text between objects")
    func dropsNoise() {
        #expect(reassemble(["\r\nnoise }", #"{"id":2}"#, "\r\n"]) == [#"{"id":2}"#])
    }

    @Test("Keeps multibyte characters that span reports")
    func multibyte() throws {
        let message = #"{"name":"Café ☕️"}"#
        let bytes = Array(message.utf8)
        // Split inside the coffee emoji.
        let cut = try #require(bytes.firstIndex(of: 0xE2)) + 1
        var reassembler = MessageReassembler()
        let first = reassembler.append(bytes[..<cut])
        let second = reassembler.append(bytes[cut...])
        #expect(first.isEmpty)
        #expect(second.map { String(decoding: $0, as: UTF8.self) } == [message])
    }

    @Test("Discards an object that grows past the limit")
    func limit() {
        var reassembler = MessageReassembler(limit: 16)
        #expect(reassembler.append(Array(#"{"a":"0123456789abcdef"#.utf8)).isEmpty)
        #expect(reassembler.isEmpty)
        #expect(reassembler.append(Array(#"{"b":1}"#.utf8)).count == 1)
    }

    @Test("Reassembles what the framing splits")
    func framingRoundTrip() {
        let json =
            #"{"method":"v.oai.thstatus","params":[{"id":0,"c":16711680,"b":1,"e":1,"s":0.5},{"id":1,"c":255,"b":1,"e":4,"s":0.5}],"id":42}"#
        var reassembler = MessageReassembler()
        let messages = Report.rpcReports(for: Array(json.utf8)).flatMap { report in
            reassembler.append(Report.Frame(report: report)?.payload ?? [])
        }
        #expect(messages.map { String(decoding: $0, as: UTF8.self) } == [json])
    }
}
