import AppKit

let application = NSApplication.shared
let delegate = FixtureApplicationDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
