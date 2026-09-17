import Foundation

final class NativeHostRunCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int32?

    func finish(_ result: Int32) { lock.withLock { value = result } }
    func result() -> Int32? { lock.withLock { value } }
}
