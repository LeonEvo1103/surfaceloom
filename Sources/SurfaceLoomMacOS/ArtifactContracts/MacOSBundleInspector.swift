import Foundation

public struct MacOSBundleInspector {
	public let appURL: URL

	public init(appURL: URL) {
		self.appURL = appURL
	}

	public func missingNonEmptyPurposeStrings(_ keys: [String]) throws -> [String] {
		guard let bundle = Bundle(url: appURL) else {
			throw DesktopAutomationError.appBundleMissing(appURL)
		}
		return keys.filter { key in
			let value = bundle.object(forInfoDictionaryKey: key) as? String
			return value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
		}
	}
}
