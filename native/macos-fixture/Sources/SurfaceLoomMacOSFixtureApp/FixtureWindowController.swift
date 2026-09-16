import AppKit
import SurfaceLoomMacOSFixtureModel

@MainActor
final class FixtureWindowController: NSWindowController, NSWindowDelegate, NSTextFieldDelegate {
    private let state = FixtureState()
    private let lifecycleField = makeReadOnlyField(
        identity: FixtureIdentity.lifecycleState,
        value: FixtureLifecycleState.ready.rawValue
    )
    private let invokeCountField = makeReadOnlyField(
        identity: FixtureIdentity.invokeCount,
        value: "0"
    )
    private let valueInputField = FixtureValueField(string: "")
    private let valueMirrorField = makeReadOnlyField(
        identity: FixtureIdentity.valueMirror,
        value: ""
    )
    private let ambiguousCountField = makeReadOnlyField(
        identity: FixtureIdentity.ambiguousInvocationCount,
        value: "0"
    )
    private let transientStack = NSStackView()
    private lazy var transientButton = makeButton(
        identity: FixtureIdentity.transient,
        target: self,
        action: #selector(dismissTransient(_:))
    )

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = FixtureIdentity.root.name
        window.minSize = NSSize(width: 700, height: 520)
        window.center()
        configureAccessibility(window, identity: FixtureIdentity.root)

        super.init(window: window)
        window.delegate = self
        window.contentView = makeContentView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    private func makeContentView() -> NSView {
        let heading = NSTextField(labelWithString: FixtureIdentity.root.name)
        heading.font = .systemFont(ofSize: 24, weight: .semibold)
        let subtitle = NSTextField(labelWithString: "Deterministic controls for native conformance")

        configureAccessibility(valueInputField, identity: FixtureIdentity.valueInput)
        valueInputField.delegate = self
        valueInputField.onAccessibilityValueChange = { [weak self] value in
            self?.acceptInputValue(value)
        }

        let closeButton = makeButton(
            identity: FixtureIdentity.close,
            target: self,
            action: #selector(closeFixture(_:))
        )
        let invokeButton = makeButton(
            identity: FixtureIdentity.invoke,
            target: self,
            action: #selector(recordInvoke(_:))
        )
        let ambiguousA = makeButton(
            identity: FixtureIdentity.ambiguousA,
            target: self,
            action: #selector(recordAmbiguousInvoke(_:))
        )
        let ambiguousB = makeButton(
            identity: FixtureIdentity.ambiguousB,
            target: self,
            action: #selector(recordAmbiguousInvoke(_:))
        )
        let ambiguousButtons = NSStackView(views: [ambiguousA, ambiguousB])
        ambiguousButtons.orientation = .horizontal
        ambiguousButtons.spacing = 8

        let restoreButton = makeButton(
            identity: FixtureIdentity.transientRestore,
            target: self,
            action: #selector(restoreTransient(_:))
        )
        transientStack.orientation = .vertical
        transientStack.alignment = .leading
        transientStack.spacing = 8
        transientStack.addArrangedSubview(transientButton)
        transientStack.addArrangedSubview(restoreButton)

        let left = NSStackView(views: [
            makeSection(title: "Owned lifecycle", views: [lifecycleField, closeButton]),
            makeSection(title: "Invoke", views: [invokeButton, invokeCountField]),
            makeSection(title: "Set value", views: [valueInputField, valueMirrorField]),
        ])
        left.orientation = .vertical
        left.alignment = .leading
        left.spacing = 12

        let right = NSStackView(views: [
            makeSection(title: "Strict ambiguity", views: [ambiguousButtons, ambiguousCountField]),
            makeSection(title: "Disappearing element", views: [transientStack]),
        ])
        right.orientation = .vertical
        right.alignment = .leading
        right.spacing = 12

        let columns = NSStackView(views: [left, right])
        columns.orientation = .horizontal
        columns.alignment = .top
        columns.distribution = .fillEqually
        columns.spacing = 16

        let root = NSStackView(views: [heading, subtitle, columns])
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 8
        root.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        root.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            root.topAnchor.constraint(equalTo: container.topAnchor),
            root.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor),
            columns.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -48),
        ])
        return container
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, field === valueInputField else { return }
        acceptInputValue(field.stringValue)
    }

    @objc private func recordInvoke(_ sender: NSButton) {
        invokeCountField.integerValue = state.recordInvoke()
    }

    @objc private func recordAmbiguousInvoke(_ sender: NSButton) {
        ambiguousCountField.integerValue = state.recordAmbiguousInvocation()
    }

    @objc private func dismissTransient(_ sender: NSButton) {
        guard state.dismissTransient() else { return }
        transientStack.removeArrangedSubview(transientButton)
        transientButton.removeFromSuperview()
    }

    @objc private func restoreTransient(_ sender: NSButton) {
        guard state.restoreTransient() else { return }
        transientStack.insertArrangedSubview(transientButton, at: 0)
    }

    @objc private func closeFixture(_ sender: NSButton) {
        beginClosing()
        close()
    }

    func windowWillClose(_ notification: Notification) {
        beginClosing()
    }

    private func beginClosing() {
        state.beginClosing()
        lifecycleField.stringValue = FixtureLifecycleState.closing.rawValue
    }

    private func acceptInputValue(_ value: String) {
        state.setValue(value)
        valueMirrorField.stringValue = value
    }
}
