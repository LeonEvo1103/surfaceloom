import Foundation

enum MacOSBoundedTraversal {
    static func walk<Node: AnyObject>(
        root: Node,
        maximumNodes: Int,
        maximumChildren: Int,
        context: NativeHostExecutionContext,
        hash: (Node) -> Int,
        equal: (Node, Node) -> Bool,
        children: (Node) throws -> [Node],
        visit: (Node) throws -> Void
    ) throws {
        var queue = [root]
        var hashes: [Int: [Node]] = [hash(root): [root]]
        var index = 0
        while index < queue.count {
            try requireRunning(context)
            let current = queue[index]
            index += 1
            try visit(current)
            try requireRunning(context)
            let descendants = try children(current)
            guard descendants.count <= maximumChildren else {
                throw macOSBackendError("ax_children_unavailable", .backend,
                                        "The AX child relationship exceeded its safety limit.")
            }
            for child in descendants {
                try requireRunning(context)
                let childHash = hash(child)
                if hashes[childHash]?.contains(where: { equal($0, child) }) == true {
                    throw macOSBackendError("ax_traversal_cycle", .backend,
                                            "The AX hierarchy contains a repeated element.")
                }
                guard queue.count < maximumNodes else {
                    throw macOSBackendError("ax_traversal_truncated", .backend,
                                            "The AX hierarchy exceeds the bounded traversal limit.")
                }
                hashes[childHash, default: []].append(child)
                queue.append(child)
            }
        }
    }

    private static func requireRunning(_ context: NativeHostExecutionContext) throws {
        if context.isCancellationRequested {
            throw macOSBackendError("request_cancelled", .cancelled, "The AX traversal was cancelled.")
        }
        if context.deadline.isExpired() {
            throw macOSBackendError("deadline_exceeded", .deadline,
                                    "The AX traversal exceeded its request deadline.")
        }
    }
}
