/// Runs async operations one at a time, in the order in which they arrive.
///
/// An actor alone does not serialize work across suspension points:
/// while one call awaits, another call on the same actor can run.
/// A serial queue holds each operation until the one before it finishes.
///
/// A call whose task is canceled before its turn leaves the queue without running its operation.
actor SerialQueue {
    private struct Waiter {
        var id: Int
        var continuation: CheckedContinuation<Void, any Error>
    }

    private var busy = false
    private var waiting: [Waiter] = []
    private var nextID = 0

    /// Runs an operation after every operation that arrived before it has finished.
    ///
    /// - Parameter operation: The operation.
    /// - Returns: What the operation returns.
    /// - Throws: `CancellationError` if the task is canceled before the operation starts,
    ///   or what the operation throws.
    func run<Result: Sendable>(_ operation: @Sendable () async throws -> Result) async throws -> Result {
        try await acquire()
        defer { release() }
        try Task.checkCancellation()
        return try await operation()
    }

    /// Waits until the queue is free, then holds it.
    private func acquire() async throws {
        guard busy else {
            busy = true
            return
        }
        let id = nextID
        nextID += 1
        try await withTaskCancellationHandler {
            try await waitInLine(id)
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }

    /// Waits until the queue is handed to the caller, or the caller is canceled.
    private func waitInLine(_ id: Int) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            if Task.isCancelled {
                continuation.resume(throwing: CancellationError())
            } else {
                waiting.append(Waiter(id: id, continuation: continuation))
            }
        }
    }

    /// Hands the queue to the next waiter, or frees it.
    private func release() {
        if waiting.isEmpty {
            busy = false
        } else {
            waiting.removeFirst().continuation.resume()
        }
    }

    /// Takes a canceled call out of the line; a call that already holds the queue is left alone.
    private func cancelWaiter(_ id: Int) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}
