import CoreGraphics

public struct MacOSShortcut: Sendable, Equatable {
	let virtualKey: CGKeyCode
	let flagsRawValue: UInt64

	private init(virtualKey: CGKeyCode, flags: CGEventFlags) {
		self.virtualKey = virtualKey
		self.flagsRawValue = flags.rawValue
	}

	var flags: CGEventFlags { CGEventFlags(rawValue: flagsRawValue) }

	public static let commandW = Self(virtualKey: 13, flags: .maskCommand)
	public static let commandQ = Self(virtualKey: 12, flags: .maskCommand)
	public static let commandShiftG = Self(
		virtualKey: 5,
		flags: [.maskCommand, .maskShift]
	)
	public static let arrowDown = Self(virtualKey: 125, flags: [])
	public static let enter = Self(virtualKey: 36, flags: [])
	public static let escape = Self(virtualKey: 53, flags: [])
}
