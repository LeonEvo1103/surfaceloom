import ApplicationServices
import Foundation

public enum MacOSAXScope: Sendable, Equatable {
	case application
	case desktop
	case focusedMenu
	case menuBar
}

public enum MacOSAXMatchPolicy: Sendable, Equatable {
	case strict
	case index(Int)
}

public struct MacOSAXLocator: Sendable {
	public let name: String
	public let identifiers: [String]
	public let labels: [String]
	public let roles: [String]
	public let scope: MacOSAXScope
	public let timeout: TimeInterval
	public let matchPolicy: MacOSAXMatchPolicy

	public init(
		_ name: String,
		identifiers: [String] = [],
		labels: [String] = [],
		roles: [String] = [],
		scope: MacOSAXScope = .application,
		timeout: TimeInterval = 8,
		matchPolicy: MacOSAXMatchPolicy = .strict
	) {
		self.name = name
		self.identifiers = identifiers
		self.labels = labels
		self.roles = roles
		self.scope = scope
		self.timeout = timeout
		self.matchPolicy = matchPolicy
	}
}

public enum MacOSAXRole {
	public static let application = kAXApplicationRole as String
	public static let button = kAXButtonRole as String
	public static let checkBox = kAXCheckBoxRole as String
	public static let dialog = "AXDialog"
	public static let group = kAXGroupRole as String
	public static let link = "AXLink"
	public static let menuBarItem = kAXMenuBarItemRole as String
	public static let menuItem = kAXMenuItemRole as String
	public static let popUpButton = kAXPopUpButtonRole as String
	public static let popover = kAXPopoverRole as String
	public static let row = kAXRowRole as String
	public static let sheet = kAXSheetRole as String
	public static let staticText = kAXStaticTextRole as String
	public static let textArea = kAXTextAreaRole as String
	public static let textField = kAXTextFieldRole as String
	public static let window = kAXWindowRole as String
}
