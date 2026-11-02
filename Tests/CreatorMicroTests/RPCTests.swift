import CreatorMicro
import Foundation
import Testing

@Suite("JSON-RPC messages")
struct RPCTests {
    @Test("Requests encode method, params, and id without a jsonrpc member")
    func requestEncoding() {
        let request = RPCRequest(method: "device.status", id: 7)
        #expect(request.json.jsonString == #"{"id":7,"method":"device.status"}"#)
        let withParams = RPCRequest(method: "fs.list", params: ["rec": true], id: 999)
        #expect(withParams.json.jsonString == #"{"id":999,"method":"fs.list","params":{"rec":true}}"#)
        #expect(RPCRequest(json: withParams.json) == withParams)
    }

    @Test("Replies and notifications parse")
    func messages() {
        #expect(
            RPCMessage(bytes: Array(#"{"id":12,"result":{"ok":1},"method":"x"}"#.utf8))
                == .reply(id: 12, result: ["ok": 1], error: nil)
        )
        #expect(
            RPCMessage(bytes: Array(#"{"id":3,"error":{"code":-32601,"message":"Method not found"}}"#.utf8))
                == .reply(id: 3, result: nil, error: ["code": -32601, "message": "Method not found"])
        )
        #expect(
            RPCMessage(bytes: Array(#"{"m":"v.oai.hid","p":{"k":"AG00","act":1}}"#.utf8))
                == .notification(method: "v.oai.hid", params: ["k": "AG00", "act": 1])
        )
        #expect(RPCMessage(bytes: Array(#"{"x":1}"#.utf8)) == nil)
        #expect(RPCMessage(bytes: Array("not json".utf8)) == nil)
    }

    @Test("Request identifiers run from 1 to 999 and wrap")
    func idsWrap() {
        var ids = RequestIDGenerator(first: 998)
        #expect(ids.next() == 998)
        #expect(ids.next() == 999)
        #expect(ids.next() == 1)
        #expect(ids.next() == 2)
    }

    @Test("Request identifiers skip those in use")
    func idsSkipInUse() {
        var ids = RequestIDGenerator(first: 5)
        #expect(ids.next(excluding: [5, 6]) == 7)
        var full = RequestIDGenerator(first: 1)
        #expect(full.next(excluding: Set(1 ... 999)) == nil)
    }

    @Test("Identifiers out of range clamp into range")
    func idsClamp() {
        var low = RequestIDGenerator(first: 0)
        #expect(low.next() == 1)
        var high = RequestIDGenerator(first: 5000)
        #expect(high.next() == 999)
    }

    @Test("Every generated identifier is within 1...999")
    func idsRange() {
        var ids = RequestIDGenerator()
        for _ in 0 ..< 2500 {
            let id = ids.next()
            #expect((1 ... 999).contains(id ?? 0))
        }
    }

    @Test("File writes are refused; reads and other methods are allowed")
    func fileWritesRefused() {
        for method in ["fs.write", "fs.writebin", "fs.delete", "fs.format", "fs.readbin"] {
            #expect(!KeypadMethod.isAllowed(method))
        }
        for method in ["fs.list", "fs.read", "sys.version", "v.oai.thstatus"] {
            #expect(KeypadMethod.isAllowed(method))
        }
    }
}

@Suite("JSON values")
struct JSONValueTests {
    @Test("Integral numbers encode without a fraction")
    func integers() {
        let value: JSONValue = ["a": 1, "b": 0.5, "c": 16_711_680, "d": [true, nil, "x"]]
        #expect(value.jsonString == #"{"a":1,"b":0.5,"c":16711680,"d":[true,null,"x"]}"#)
    }

    @Test("Values parse and round-trip")
    func parsing() throws {
        let text = #"{"battery":50,"is_charging":true,"name":"a/b","list":[1,2.5,null],"nested":{"x":{}}}"#
        let value = try JSONValue(parsing: Data(text.utf8))
        #expect(value["battery"]?.intValue == 50)
        #expect(value["is_charging"]?.boolValue == true)
        #expect(value["list"]?.arrayValue?.count == 3)
        #expect(value["list"]?.arrayValue?[1].doubleValue == 2.5)
        #expect(value["list"]?.arrayValue?[1].intValue == nil)
        #expect(value["name"]?.stringValue == "a/b")
        #expect(try JSONValue(parsing: value.encoded()) == value)
    }

    @Test("Booleans and numbers stay distinct")
    func boolsAndNumbers() throws {
        let value = try JSONValue(parsing: Data("[true,1,0,false]".utf8))
        #expect(value == [true, 1, 0, false])
    }

    @Test("Non-finite numbers encode as null")
    func nonFinite() {
        #expect(JSONValue.number(.infinity).jsonString == "null")
    }
}
