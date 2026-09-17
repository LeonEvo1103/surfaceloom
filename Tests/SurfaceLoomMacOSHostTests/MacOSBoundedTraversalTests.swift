import Foundation
import Testing
@testable import SurfaceLoomMacOSHost

@Suite("macOS bounded AX traversal")
struct MacOSBoundedTraversalTests {
    final class Node {
        var children: [Node] = []
    }

    @Test("A duplicate edge after 5000 nodes fails as a cycle")
    func tailDuplicate() throws {
        let nodes = (0..<5_000).map { _ in Node() }
        for index in 0..<4_999 { nodes[index].children = [nodes[index + 1]] }
        nodes[4_999].children = [nodes[0]]
        let error = capture {
            try walk(nodes[0])
        }
        #expect(error?.code == "ax_traversal_cycle")
    }

    @Test("An unreadable child relationship fails closed")
    func childrenError() throws {
        let root = Node()
        let context = makeContext(timeout: 1_000)
        let error = capture {
            try MacOSBoundedTraversal.walk(
                root: root, maximumNodes: 5_000, maximumChildren: 1_024,
                context: context,
                hash: { ObjectIdentifier($0).hashValue }, equal: { $0 === $1 },
                children: { _ in throw macOSBackendError("ax_children_unavailable", .backend) },
                visit: { _ in }
            )
        }
        #expect(error?.code == "ax_children_unavailable")
    }

    @Test("Deadline and cancellation stop traversal cooperatively")
    func stoppedTraversal() throws {
        let expired = capture { try walk(Node(), context: makeContext(timeout: 0)) }
        #expect(expired?.code == "deadline_exceeded")
        let cancellation = NativeCancellationState()
        cancellation.cancel()
        let context = NativeHostExecutionContext(
            cancellation: cancellation,
            deadline: NativeHostDeadline(
                receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds,
                timeoutMilliseconds: 1_000
            )
        )
        let cancelled = capture { try walk(Node(), context: context) }
        #expect(cancelled?.code == "request_cancelled")
    }

    private func walk(
        _ root: Node,
        context: NativeHostExecutionContext? = nil
    ) throws {
        try MacOSBoundedTraversal.walk(
            root: root, maximumNodes: 5_000, maximumChildren: 1_024,
            context: context ?? makeContext(timeout: 5_000),
            hash: { ObjectIdentifier($0).hashValue }, equal: { $0 === $1 },
            children: { $0.children }, visit: { _ in }
        )
    }

    private func makeContext(timeout: Int) -> NativeHostExecutionContext {
        NativeHostExecutionContext(
            cancellation: NativeCancellationState(),
            deadline: NativeHostDeadline(
                receivedUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds,
                timeoutMilliseconds: timeout
            )
        )
    }

    private func capture(_ body: () throws -> Void) -> NativeHostBackendError? {
        do {
            try body()
            Issue.record("expected traversal failure")
            return nil
        } catch let error as NativeHostBackendError {
            return error
        } catch {
            Issue.record("unexpected error type")
            return nil
        }
    }
}
