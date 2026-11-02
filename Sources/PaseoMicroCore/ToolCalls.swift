import MCP
import Synchronization

/// The tool calls of one MCP connection, in tasks that the app owns.
///
/// The MCP SDK runs each handler in a task of its own,
/// which neither a closed connection nor a stopped server cancels.
/// Running the tool's work in a task that this scope holds lets the server cancel it
/// when the connection ends or the server closes, and wait for it to finish.
final class ToolCalls: Sendable {
    private struct State {
        var canceled = false
        var nextID = 0
        var tasks: [Int: Task<CallTool.Result, Never>] = [:]
    }

    private let state = Mutex(State())

    /// Runs a tool call in a task that ``cancel()`` reaches.
    ///
    /// Canceling the calling task also cancels the call.
    ///
    /// - Parameter operation: The tool's work.
    /// - Returns: What the operation returns,
    ///   or an error result without running it if the scope was canceled.
    func run(_ operation: @escaping @Sendable () async -> CallTool.Result) async -> CallTool.Result {
        let started = state.withLock { state -> (Int, Task<CallTool.Result, Never>)? in
            guard !state.canceled else { return nil }
            let id = state.nextID
            state.nextID += 1
            let task = Task { await operation() }
            state.tasks[id] = task
            return (id, task)
        }
        guard let (id, task) = started else {
            return CallTool.Result(
                content: [.text(text: "The connection closed", annotations: nil, _meta: nil)],
                isError: true
            )
        }
        let result = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        state.withLock { _ = $0.tasks.removeValue(forKey: id) }
        return result
    }

    /// Cancels every call in progress and refuses new ones.
    func cancel() {
        let tasks = state.withLock { state in
            state.canceled = true
            return Array(state.tasks.values)
        }
        for task in tasks { task.cancel() }
    }

    /// Waits until every call that started has finished.
    ///
    /// Call it after ``cancel()``, so that no new call can start.
    func wait() async {
        let tasks = state.withLock { Array($0.tasks.values) }
        for task in tasks { _ = await task.value }
    }
}
