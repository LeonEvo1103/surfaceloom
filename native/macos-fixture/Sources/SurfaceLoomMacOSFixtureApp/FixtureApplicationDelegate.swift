import AppKit

@MainActor
final class FixtureApplicationDelegate: NSObject, NSApplicationDelegate {
    private var fixtureWindowController: FixtureWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = FixtureWindowController()
        fixtureWindowController = controller
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
