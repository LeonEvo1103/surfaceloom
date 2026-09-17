import AppKit
import SurfaceLoomMacOSFixtureModel

@MainActor
final class FixtureValueField: NSTextField {
    var onAccessibilityValueChange: ((String) -> Void)?

    override func setAccessibilityValue(_ accessibilityValue: Any?) {
        super.setAccessibilityValue(accessibilityValue)
        guard let value = accessibilityValue as? String else { return }
        stringValue = value
        onAccessibilityValueChange?(value)
    }
}

@MainActor
func configureAccessibility(
    _ element: NSAccessibilityProtocol,
    identity: FixtureElementIdentity
) {
    element.setAccessibilityIdentifier(identity.identifier)
    element.setAccessibilityLabel(identity.name)
}

@MainActor
func makeButton(
    identity: FixtureElementIdentity,
    target: AnyObject,
    action: Selector
) -> NSButton {
    let button = NSButton(title: identity.name, target: target, action: action)
    button.bezelStyle = .rounded
    configureAccessibility(button, identity: identity)
    return button
}

@MainActor
func makeReadOnlyField(identity: FixtureElementIdentity, value: String) -> NSTextField {
    let field = NSTextField(string: value)
    field.isEditable = false
    field.isSelectable = true
    field.isBezeled = true
    field.drawsBackground = true
    configureAccessibility(field, identity: identity)
    return field
}

@MainActor
func makeSection(title: String, views: [NSView]) -> NSStackView {
    let titleField = NSTextField(labelWithString: title)
    titleField.font = .boldSystemFont(ofSize: NSFont.systemFontSize)

    let stack = NSStackView(views: [titleField] + views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    stack.wantsLayer = true
    stack.layer?.borderColor = NSColor.separatorColor.cgColor
    stack.layer?.borderWidth = 1
    stack.layer?.cornerRadius = 6
    return stack
}
