import Foundation

public struct NativeFileDialogComponent: MacOSComponent {
	public let driver: MacOSApplicationDriver

	private static let cancelButton = MacOSAXLocator(
		"native file dialog Cancel button",
		labels: ["Cancel", "取消"],
		roles: [MacOSAXRole.button],
		timeout: 10
	)
	private static let goToFolderPath = MacOSAXLocator(
		"native file dialog Go to Folder path",
		identifiers: ["PathTextField"],
		roles: [MacOSAXRole.textField],
		timeout: 8
	)
	private static let confirmButton = MacOSAXLocator(
		"native file dialog confirmation button",
		identifiers: ["OKButton"],
		labels: ["Open", "Choose", "打开", "选择"],
		roles: [MacOSAXRole.button],
		timeout: 8
	)

	public init(driver: MacOSApplicationDriver) {
		self.driver = driver
	}

	public func waitUntilPresented(timeout: TimeInterval = 10) -> Bool {
		driver.exists(Self.cancelButton, timeout: timeout)
	}

	public func cancel() throws {
		try driver.press(Self.cancelButton)
	}

	public func waitUntilDismissed(timeout: TimeInterval = 8) -> Bool {
		driver.waitForElementToDisappear(Self.cancelButton, timeout: timeout)
	}

	public func selectDirectory(at directoryURL: URL) throws {
		var isDirectory: ObjCBool = false
		guard directoryURL.isFileURL,
			FileManager.default.fileExists(
				atPath: directoryURL.path,
				isDirectory: &isDirectory
			),
			isDirectory.boolValue
		else {
			throw DesktopAutomationError.actionFailed(
				"Native directory selection requires an existing local directory"
			)
		}
		guard waitUntilPresented() else {
			throw DesktopAutomationError.actionFailed(
				"Native directory selection panel was not presented"
			)
		}

		try driver.withRecoverableUIStateChange(
			operationKey: "native.directory-selection.roundtrip",
			body: {
				try driver.pressShortcut(.commandShiftG)
				let pathField = try driver.findElement(Self.goToFolderPath)
				let requestedPath = directoryURL.standardizedFileURL.path
				try driver.focus(pathField)
				try driver.setValue(requestedPath, on: pathField)
				guard try driver.strictStringValue(of: pathField) == requestedPath else {
					throw DesktopAutomationError.actionFailed(
						"Native Go to Folder did not preserve the requested absolute path"
					)
				}
				try driver.pressShortcut(.enter)
				try driver.requireStableAbsence(Self.goToFolderPath, timeout: 8)
				if waitUntilPresented(timeout: 0.5) {
					let confirm = try driver.findElement(Self.confirmButton)
					guard try driver.strictEnabledValue(of: confirm) == true else {
						throw DesktopAutomationError.actionFailed(
							"Native directory confirmation did not expose an explicit enabled state"
						)
					}
					try driver.press(confirm)
				}
			},
			recover: restoreDismissedBaseline,
			proveBaseline: requireDismissedBaseline
		)
	}

	public func restoreDismissedBaseline() throws {
		if try driver.observePresence(Self.goToFolderPath) == .present {
			try driver.pressShortcut(.escape)
		}
		if try driver.observePresence(Self.cancelButton) == .present {
			try cancel()
		}
	}

	public func requireDismissedBaseline() throws {
		try driver.requireStableAbsence(Self.goToFolderPath)
		try driver.requireStableAbsence(Self.cancelButton, timeout: 12)
	}
}
