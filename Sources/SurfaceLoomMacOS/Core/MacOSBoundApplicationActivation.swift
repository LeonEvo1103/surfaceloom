import AppKit
import ApplicationServices
import Foundation

/// SL-P3-015: activation precedes input; never replay a key or click to recover focus.
enum MacOSBoundApplicationActivation {
    static func perform(isAlive: () -> Bool, isActive: () -> Bool,
                        requestActivation: () -> Void, waitForActivation: () -> Bool,
                        raiseBoundWindow: () -> Bool) -> Bool {
        guard isAlive() else { return false }
        if isActive() { return true }
        requestActivation()
        if waitForActivation() { return isAlive() && isActive() }
        guard isAlive(), raiseBoundWindow() else { return false }
        requestActivation()
        return waitForActivation() && isAlive() && isActive()
    }
}

extension MacOSApplicationDriver {
    func activateBoundApplication(timeout: TimeInterval) -> Bool {
        guard let application else { return false }
        let deadline = Date().addingTimeInterval(max(timeout, 0))
        return MacOSBoundApplicationActivation.perform(
            isAlive: { self.isProcessAlive(application.processIdentifier) },
            isActive: { application.isActive },
            requestActivation: { _ = application.activate() },
            waitForActivation: {
                self.wait(until: { application.isActive },
                          timeout: min(1, max(0, deadline.timeIntervalSinceNow)))
            },
            raiseBoundWindow: {
                let root = AXUIElementCreateApplication(application.processIdentifier)
                var value: CFTypeRef?
                guard AXUIElementCopyAttributeValue(root, kAXMainWindowAttribute as CFString, &value) == .success,
                      let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
                let window = value as! AXUIElement
                var pid: pid_t = 0
                guard AXUIElementGetPid(window, &pid) == .success,
                      pid == application.processIdentifier else { return false }
                var actions: CFArray?
                guard AXUIElementCopyActionNames(window, &actions) == .success,
                      let names = actions as? [String], names.contains(kAXRaiseAction) else { return false }
                return AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
            }
        )
    }
}
