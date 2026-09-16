import Foundation
import SurfaceLoomMacOSFixtureModel

private struct ModelTestRunner {
    private var passed = 0

    mutating func run(_ name: String, _ body: () throws -> Void) rethrows {
        try body()
        passed += 1
        print("ok \(passed) - \(name)")
    }

    func finish() {
        print("1..\(passed)")
    }
}

private struct ModelTestFailure: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw ModelTestFailure(description: message) }
}

do {
    var tests = ModelTestRunner()

    try tests.run("initial state matches contract") {
        let snapshot = FixtureState().snapshot()
        try expect(snapshot.invokeCount == 0, "invokeCount")
        try expect(snapshot.inputValue == "", "inputValue")
        try expect(snapshot.ambiguousInvocationCount == 0, "ambiguousInvocationCount")
        try expect(snapshot.transientVisible, "transientVisible")
        try expect(snapshot.lifecycleState == .ready, "lifecycleState")
    }

    try tests.run("invoke increments exactly once") {
        let state = FixtureState()
        try expect(state.recordInvoke() == 1, "first invoke")
        try expect(state.recordInvoke() == 2, "second invoke")
        try expect(state.snapshot().invokeCount == 2, "snapshot invokeCount")
    }

    try tests.run("setValue is mirrored by snapshot") {
        let state = FixtureState()
        state.setValue("SurfaceLoom value ✓")
        try expect(state.snapshot().inputValue == "SurfaceLoom value ✓", "inputValue")
    }

    try tests.run("ambiguous invocation has only explicit side effects") {
        let state = FixtureState()
        try expect(state.snapshot().ambiguousInvocationCount == 0, "initial ambiguous count")
        try expect(state.recordAmbiguousInvocation() == 1, "recorded ambiguous count")
        try expect(state.snapshot().ambiguousInvocationCount == 1, "snapshot ambiguous count")
    }

    try tests.run("transient removal and restoration are idempotent") {
        let state = FixtureState()
        try expect(state.dismissTransient(), "first dismiss")
        try expect(!state.dismissTransient(), "second dismiss")
        try expect(!state.snapshot().transientVisible, "dismissed state")
        try expect(state.restoreTransient(), "first restore")
        try expect(!state.restoreTransient(), "second restore")
        try expect(state.snapshot().transientVisible, "restored state")
    }

    try tests.run("closing is idempotent") {
        let state = FixtureState()
        state.beginClosing()
        state.beginClosing()
        try expect(state.snapshot().lifecycleState == .closing, "lifecycleState")
    }

    try tests.run("automation identifiers are unique and stable") {
        let identities = [FixtureIdentity.root] + FixtureIdentity.controls
        try expect(Set(identities.map(\.identifier)).count == identities.count, "unique identifiers")
        try expect(
            identities.allSatisfy { $0.identifier.hasPrefix("surfaceloom.fixture.") },
            "identifier prefix"
        )
    }

    try tests.run("ambiguous controls share a name but not an identifier") {
        try expect(FixtureIdentity.ambiguousA.name == FixtureIdentity.ambiguousB.name, "same name")
        try expect(
            FixtureIdentity.ambiguousA.identifier != FixtureIdentity.ambiguousB.identifier,
            "different identifiers"
        )
    }

    tests.finish()
} catch {
    FileHandle.standardError.write(Data("not ok - \(error)\n".utf8))
    exit(EXIT_FAILURE)
}
