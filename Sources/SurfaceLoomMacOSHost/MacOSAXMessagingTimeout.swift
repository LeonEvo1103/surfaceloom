import ApplicationServices
import Foundation

struct MacOSAXMessagingTimeout: @unchecked Sendable {
    typealias Apply = @Sendable (AXUIElement, Float) -> AXError
    private let apply: Apply

    init(apply: @escaping Apply = AXUIElementSetMessagingTimeout) {
        self.apply = apply
    }

    func configure(_ element: AXUIElement, context: NativeHostExecutionContext) throws {
        if context.isCancellationRequested {
            throw macOSBackendError("request_cancelled", .cancelled, "The AX request was cancelled.")
        }
        let remaining = context.deadline.remainingMilliseconds()
        guard remaining > 0 else {
            throw macOSBackendError("deadline_exceeded", .deadline, "The AX request exceeded its deadline.")
        }
        let seconds = Float(Double(remaining) / 1_000)
        guard seconds > 0, apply(element, seconds) == .success else {
            throw macOSBackendError("ax_messaging_timeout_unavailable", .backend,
                                    "The AX messaging timeout could not be configured safely.")
        }
    }
}
