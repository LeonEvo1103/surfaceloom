import Testing
@testable import SurfaceLoomMacOS

struct MacOSBoundApplicationActivationTests {
    @Test func alreadyActiveDoesNotRequestActivation() {
        var actions = 0
        let result = MacOSBoundApplicationActivation.perform(isAlive: { true }, isActive: { true },
            requestActivation: { actions += 1 }, waitForActivation: { false }, raiseBoundWindow: { actions += 1; return true })
        #expect(result); #expect(actions == 0)
    }
    @Test func raisesOnceOnlyAfterActivationFailsAndRechecksFocus() {
        var active = false; var activations = 0; var raises = 0
        let result = MacOSBoundApplicationActivation.perform(isAlive: { true }, isActive: { active },
            requestActivation: { activations += 1 }, waitForActivation: { active },
            raiseBoundWindow: { raises += 1; active = true; return true })
        #expect(result); #expect(activations == 2); #expect(raises == 1)
    }
    @Test func missingWindowOrUnconfirmedForegroundFailsClosed() {
        for raised in [false, true] {
            let result = MacOSBoundApplicationActivation.perform(isAlive: { true }, isActive: { false },
                requestActivation: {}, waitForActivation: { false }, raiseBoundWindow: { raised })
            #expect(!result)
        }
        var touched = false
        #expect(!MacOSBoundApplicationActivation.perform(isAlive: { false }, isActive: { true },
            requestActivation: { touched = true }, waitForActivation: { true }, raiseBoundWindow: { touched = true; return true }))
        #expect(!touched)
    }
}
