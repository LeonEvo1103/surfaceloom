enum MacOSAXMatchResolver {
	static func prioritizedMatches<Element>(
		_ candidates: [Element],
		identifiers: Set<String>,
		labels: Set<String>,
		identifierOf: (Element) -> String,
		labelsOf: (Element) -> Set<String>
	) -> [Element] {
		if !identifiers.isEmpty {
			let identifierMatches = candidates.filter {
				identifiers.contains(identifierOf($0))
			}
			if !identifierMatches.isEmpty { return identifierMatches }
		}

		if !labels.isEmpty {
			return candidates.filter {
				!labels.isDisjoint(with: labelsOf($0))
			}
		}
		return identifiers.isEmpty ? candidates : []
	}

	static func validate(_ locator: MacOSAXLocator) throws {
		guard case let .index(index) = locator.matchPolicy, index < 0 else { return }
		throw DesktopAutomationError.invalidMatchPolicy(
			locator,
			reason: "index must be non-negative"
		)
	}

	static func lookupLimit(for policy: MacOSAXMatchPolicy) -> Int {
		switch policy {
		case .strict:
			return 2
		case let .index(index):
			guard index < Int.max else { return Int.max }
			return max(index + 1, 1)
		}
	}

	static func hasResolvableMatch(
		count: Int,
		policy: MacOSAXMatchPolicy
	) -> Bool {
		switch policy {
		case .strict:
			return count > 0
		case let .index(index):
			return index >= 0 && count > index
		}
	}

	static func resolve<Element>(
		_ matches: [Element],
		for locator: MacOSAXLocator
	) throws -> Element? {
		try validate(locator)
		switch locator.matchPolicy {
		case .strict:
			guard matches.count < 2 else {
				throw DesktopAutomationError.elementAmbiguous(
					locator,
					observedMatchCount: matches.count
				)
			}
			return matches.first
		case let .index(index):
			guard matches.indices.contains(index) else { return nil }
			return matches[index]
		}
	}
}
