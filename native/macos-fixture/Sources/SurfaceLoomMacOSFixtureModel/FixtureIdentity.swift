public struct FixtureElementIdentity: Equatable, Sendable {
    public let key: String
    public let controlType: String
    public let identifier: String
    public let name: String

    public init(key: String, controlType: String, identifier: String, name: String) {
        self.key = key
        self.controlType = controlType
        self.identifier = identifier
        self.name = name
    }
}

public enum FixtureIdentity {
    public static let root = FixtureElementIdentity(
        key: "root",
        controlType: "window",
        identifier: "surfaceloom.fixture.window.main",
        name: "SurfaceLoom AX Fixture"
    )

    public static let lifecycleState = FixtureElementIdentity(
        key: "lifecycleState",
        controlType: "edit",
        identifier: "surfaceloom.fixture.lifecycle.state",
        name: "Lifecycle state"
    )
    public static let close = FixtureElementIdentity(
        key: "close",
        controlType: "button",
        identifier: "surfaceloom.fixture.lifecycle.close",
        name: "Close fixture"
    )
    public static let invoke = FixtureElementIdentity(
        key: "invoke",
        controlType: "button",
        identifier: "surfaceloom.fixture.invoke",
        name: "Invoke once"
    )
    public static let invokeCount = FixtureElementIdentity(
        key: "invokeCount",
        controlType: "edit",
        identifier: "surfaceloom.fixture.invoke-count",
        name: "Invoke count"
    )
    public static let valueInput = FixtureElementIdentity(
        key: "valueInput",
        controlType: "edit",
        identifier: "surfaceloom.fixture.value-input",
        name: "Fixture value"
    )
    public static let valueMirror = FixtureElementIdentity(
        key: "valueMirror",
        controlType: "edit",
        identifier: "surfaceloom.fixture.value-mirror",
        name: "Value mirror"
    )
    public static let ambiguousA = FixtureElementIdentity(
        key: "ambiguousA",
        controlType: "button",
        identifier: "surfaceloom.fixture.ambiguous.a",
        name: "Ambiguous action"
    )
    public static let ambiguousB = FixtureElementIdentity(
        key: "ambiguousB",
        controlType: "button",
        identifier: "surfaceloom.fixture.ambiguous.b",
        name: "Ambiguous action"
    )
    public static let ambiguousInvocationCount = FixtureElementIdentity(
        key: "ambiguousInvocationCount",
        controlType: "edit",
        identifier: "surfaceloom.fixture.ambiguous-count",
        name: "Ambiguous invocation count"
    )
    public static let transient = FixtureElementIdentity(
        key: "transient",
        controlType: "button",
        identifier: "surfaceloom.fixture.transient",
        name: "Dismiss transient control"
    )
    public static let transientRestore = FixtureElementIdentity(
        key: "transientRestore",
        controlType: "button",
        identifier: "surfaceloom.fixture.transient-restore",
        name: "Restore transient control"
    )

    public static let controls: [FixtureElementIdentity] = [
        lifecycleState,
        close,
        invoke,
        invokeCount,
        valueInput,
        valueMirror,
        ambiguousA,
        ambiguousB,
        ambiguousInvocationCount,
        transient,
        transientRestore,
    ]
}
