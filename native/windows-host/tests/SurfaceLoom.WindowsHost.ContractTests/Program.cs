using System.IO;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Client;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

public static class Program
{
    [STAThread]
    public static int Main()
    {
        var tests = new (string Name, Action Run)[]
        {
            ("protocol methods are stable and unique", ProtocolMethodsAreStable),
            ("lifecycle ownership capabilities are explicit", LifecycleCapabilitiesAreExplicit),
            ("secure desktop is explicitly unsupported", SecureDesktopIsUnsupported),
            ("doctor reports prerequisites and safety boundaries", DoctorContractTests.ReportBoundaries),
            ("limited process identity errors fail closed", WindowsProcessIdentityReaderContractTests.FailureClassificationIsFailClosed),
            ("limited process identity is handle-bound", WindowsProcessIdentityReaderContractTests.CurrentProcessUsesLimitedHandleIdentity),
            ("every public action declares its UIA mapping", ActionsHaveRequirements),
            ("locator validation rejects ambiguous requests", LocatorValidationRejectsEmpty),
            ("find-all is discoverable", ElementContractTests.FindAllIsDiscoverable),
            ("find-all retains every immediate match", ElementContractTests.FindAllReturnsEveryImmediateMatch),
            ("find-all returns empty after timeout", ElementContractTests.FindAllReturnsEmptyAfterTimeout),
            ("find-all rejects a single-result index", ElementContractTests.FindAllRejectsMatchIndex),
            ("batch UIA query is discoverable and routed", ElementContractTests.BatchQueryIsDiscoverableAndRouted),
            ("batch UIA validation is strict and bounded", ElementContractTests.BatchQueryValidationIsStrictAndBounded),
            ("batch UIA clauses retain AND and scope semantics", ElementContractTests.BatchQueryRetainsClauseSemantics),
            ("refreshed action snapshots retain every locator selector", ElementContractTests.SnapshotSelectorMatchingIsExact),
            ("checked action requests are strict", ElementContractTests.CheckedActionRequestsAreStrict),
            ("checked action targets fail closed", ElementContractTests.CheckedActionTargetsFailClosed),
            ("batch UIA output limits fail closed", ElementContractTests.BatchQueryOutputLimitsFailClosed),
            ("element-scoped find has a stable contract", ElementContractTests.ElementScopedFindContractIsStable),
            ("element handles reuse identity and stay bounded", ElementContractTests.ElementHandlesReuseIdentityAndStayBounded),
            ("failed observations never publish element handles", StableObservationTransactionContractTests.FailuresNeverReachHandleCommit),
            ("stable observations commit one whole batch", StableObservationTransactionContractTests.WholeBatchIsRevalidatedBeforeOneCommit),
            ("element snapshots expose stable optional state", ElementContractTests.SnapshotFieldsHaveStableJsonShape),
            ("semantic policies filter every declared field", ElementContractTests.SemanticPolicyFiltersEveryDeclaredField),
            ("null semantic policies retain fail-closed defaults", ElementContractTests.NullPoliciesRemainFailClosed),
            ("missing ARIA role fallback is explicit and bounded", ElementContractTests.MissingAriaRoleFallbackIsExplicitAndBounded),
            ("semantic selection requires a stable unique identity", ElementContractTests.StableSemanticSelectionIsFailClosed),
            ("stable disappearance requires consecutive absence", ElementContractTests.StableDisappearanceIsFailClosed),
            ("disclosure actions require a proven state", ElementContractTests.DisclosureActionsRequireProvenState),
            ("postcondition actions are submitted at most once", ElementContractTests.AtMostOnceActionsUsePostconditions),
            ("submission observers durably bracket one action", AtMostOnceObserverContractTests.ObserverBracketsOneSubmission),
            ("exclusive submission observers prevent replay", AtMostOnceObserverContractTests.ExclusiveObserverPreventsReplay),
            ("UI state recovery taints and blocks subsequent work", ElementContractTests.UiStateRecoveryAndTaintBarrierAreFailClosed),
            ("live element scopes resolve a fresh owner every time", ElementContractTests.LiveElementScopesAlwaysReresolve),
            ("UIA diagnostics stay bounded and redact content", ElementContractTests.SafeDiagnosticsRemainBounded),
            ("NDJSON handshake is machine-readable", NdjsonHandshakeIsMachineReadable),
            ("NDJSON doctor is machine-readable and read-only", DoctorContractTests.NdjsonIsMachineReadable),
            ("native v1 handshake is exact and advertised", NativeV1ContractTests.HandshakeIsExactAndAdvertised),
            ("native v1 deadline and cancel stop before submission", NativeV1ContractTests.DeadlineAndCancelStopBeforeSubmission),
            ("native v1 post-submission failure is unknown", NativeV1ContractTests.PostSubmissionFailureIsUnknownAndNeverRetried),
            ("native v1 reader accepts cancel during dispatch", NativeV1ContractTests.ReaderAcceptsCancelDuringDispatch),
            ("native v1 late success proves executed", NativeV1ContractTests.LateSuccessfulSideEffectProvesExecuted),
            ("native v1 scope fails closed", NativeV1ContractTests.ScopeAndOwnershipFailClosed),
            ("native v1 operation ids cannot replay", NativeV1ContractTests.OperationIdsAreConsumedWithoutReplay),
            ("native v1 frame limit counts the actual delimiter", NativeV1ContractTests.FrameBoundaryCountsActualDelimiter),
            ("native v1 never relabels legacy 0.2", NativeV1ContractTests.V1DoesNotRelabelLegacyFrames),
            ("native v1 outbound frames are bounded", NativeV1TransportContractTests.OutboundFramesAreBoundedAndPreserveOutcome),
            ("native v1 cancellation wakes idle input", NativeV1TransportContractTests.CancellationWakesIdleInputAndReachesCleanup),
            ("native v1 prepare cannot race host disposal", NativeV1TransportContractTests.PrepareCannotRegisterAfterHostDispose),
            ("native v1 outstanding ids own one terminal response", NativeV1TransportContractTests.OutstandingIdOwnsItsOnlyTerminalResponse),
            ("native v1 routing requires one exact marker", NativeV1TransportContractTests.RoutingRequiresOneExactProtocolMarker),
            ("native v1 shared duplicate-key vector fails closed", NativeV1InputHardeningContractTests.SharedDuplicateKeyVectorFailsClosed),
            ("native v1 shared raw-wire boundaries are strict", NativeV1InputHardeningContractTests.SharedRawWireBoundaryVectorsAreStrict),
            ("native v1 nested duplicate keys fail closed", NativeV1InputHardeningContractTests.NestedDuplicateKeysFailClosed),
            ("native v1 invalid UTF-8 fails closed", NativeV1InputHardeningContractTests.InvalidUtf8FailsClosed),
            ("native v1 EOF responsibility is explicit", NativeV1InputHardeningContractTests.EofResponsibilityIsExplicit),
            ("native v1 CRLF and multiple frames remain bounded", NativeV1InputHardeningContractTests.CrlfAndMultipleFramesRemainBounded),
            ("native v1 byte input preserves legacy boundary", NativeV1InputHardeningContractTests.ByteInputPreservesLegacyBoundary),
        };

        var failures = 0;
        foreach (var test in tests)
        {
            try
            {
                test.Run();
                Console.WriteLine($"PASS {test.Name}");
            }
            catch (Exception exception)
            {
                failures++;
                Console.Error.WriteLine($"FAIL {test.Name}: {exception.Message}");
            }
        }

        Console.WriteLine($"{tests.Length - failures}/{tests.Length} contract tests passed.");
        return failures == 0 ? 0 : 1;
    }

    private static void ProtocolMethodsAreStable()
    {
        Equal("0.2", HostProtocol.Version, "Protocol version changed without a contract migration.");
        Equal(HostProtocol.Methods.Count, HostProtocol.Methods.Distinct(StringComparer.Ordinal).Count(),
            "Protocol methods must be unique.");
        True(HostProtocol.Methods.Contains(HostProtocol.GetCapabilities),
            "Capability discovery must always be available.");
        True(HostProtocol.Methods.Contains(HostProtocol.RunDoctor),
            "Read-only environment diagnosis must always be available.");
        True(HostProtocol.Methods.Contains(HostProtocol.LaunchSession),
            "Owned process launch must be discoverable.");
        True(HostProtocol.Methods.Contains(HostProtocol.OpenDesktopSession),
            "Desktop-root system sessions must be discoverable.");
        True(HostProtocol.Methods.Contains(HostProtocol.ReleaseSession),
            "Handle release must be distinct from process close.");
        True(HostProtocol.Methods.Contains(HostProtocol.TerminateSession),
            "Owned process termination must be discoverable.");

        using var dispatcher = new RequestDispatcher();
        var oldProtocol = Throws<HostOperationException>(() => dispatcher.Dispatch(new RpcRequest
        {
            ProtocolVersion = "0.1",
            Id = "old-client",
            Method = HostProtocol.Handshake,
            Parameters = JsonSerializer.SerializeToElement(new { }, JsonDefaults.Options),
        }));
        Equal("protocol_version_mismatch", oldProtocol.Code,
            "A 0.1 client must not silently use the checked-action 0.2 host.");
    }

    private static void LifecycleCapabilitiesAreExplicit()
    {
        var features = CapabilityCatalog.Create().Features;
        Equal(SupportLevel.Supported, features["host.doctor"].Support,
            "Read-only host diagnosis must be advertised as supported.");
        Equal(SupportLevel.Supported, features["application.launch"].Support,
            "Explicit owned-process launch must be supported.");
        Equal(SupportLevel.Conditional, features["application.gracefulClose"].Support,
            "WM_CLOSE must not be advertised as guaranteed app quit.");
        Equal(SupportLevel.Supported, features["application.terminateOwned"].Support,
            "Owned-process cleanup must be supported.");
        Equal(SupportLevel.Supported, features["system.desktopRoot"].Support,
            "Default desktop root must be supported for system surfaces.");
        Equal(SupportLevel.Unsupported, features["input.pointerInjection"].Support,
            "Lifecycle support must not imply pointer injection.");

        var exception = Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(new LaunchSessionRequest { ExecutablePath = "relative.exe" }));
        Equal("invalid_request", exception.Code,
            "Launch must reject ambiguous relative executable paths.");
    }

    private static void SecureDesktopIsUnsupported()
    {
        var capabilities = CapabilityCatalog.Create();
        True(capabilities.Features.TryGetValue(CapabilityCatalog.SecureDesktopFeature, out var secureDesktop),
            "Secure Desktop capability must be declared.");
        Equal(SupportLevel.Unsupported, secureDesktop!.Support,
            "Secure Desktop must not be advertised as supported.");
        True(secureDesktop!.Summary.Contains("not be bypassed", StringComparison.OrdinalIgnoreCase),
            "Secure Desktop capability must explain the security boundary.");

        var exception = Throws<HostOperationException>(() => UiaSession.Attach(new AttachSessionRequest
        {
            ProcessId = Environment.ProcessId,
            Desktop = "secure",
        }));
        Equal("capability_unsupported", exception.Code,
            "Secure Desktop requests must fail with a structured unsupported error.");

        var desktopException = Throws<HostOperationException>(() =>
            UiaSession.OpenDesktop(new DesktopSessionRequest { Desktop = "secure" }));
        Equal("capability_unsupported", desktopException.Code,
            "Desktop-root sessions must also reject Secure Desktop.");
    }

    private static void ActionsHaveRequirements()
    {
        var actions = Enum.GetValues<UiaAction>()
            .Where(action => action != UiaAction.Unspecified)
            .ToArray();
        Equal(actions.Length, UiaActionExecutor.PatternRequirements.Count,
            "Every protocol action must have exactly one documented UIA mapping.");
        foreach (var action in actions)
        {
            True(UiaActionExecutor.PatternRequirements.TryGetValue(action, out var requirement),
                $"Missing UIA requirement for {action}.");
            True(!string.IsNullOrWhiteSpace(requirement), $"Empty UIA requirement for {action}.");
        }
    }

    private static void LocatorValidationRejectsEmpty()
    {
        var exception = Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(new UiaLocator(), allowEmpty: false));
        Equal("invalid_request", exception.Code, "Empty locators must be rejected.");

        ProtocolValidator.Validate(new UiaLocator
        {
            AutomationIds = ["saveButton"],
            ControlTypes = ["button"],
        }, allowEmpty: false);
    }

    private static void NdjsonHandshakeIsMachineReadable()
    {
        const string request =
            "{\"protocolVersion\":\"0.2\",\"id\":\"contract\",\"method\":\"host.handshake\",\"params\":{}}";
        using var input = new StringReader(request);
        using var output = new StringWriter();
        using var diagnostics = new StringWriter();

        var exitCode = new NdjsonHost(input, output, diagnostics).Run(CancellationToken.None);
        Equal(0, exitCode, "Host must exit cleanly at end of input.");
        Equal(string.Empty, diagnostics.ToString(), "Handshake must not emit diagnostics.");

        using var document = JsonDocument.Parse(output.ToString());
        var root = document.RootElement;
        Equal("contract", root.GetProperty("id").GetString() ?? string.Empty,
            "Response id must correlate with request.");
        True(root.GetProperty("ok").GetBoolean(), "Handshake must succeed.");
        Equal(HostProtocol.Version,
            root.GetProperty("result").GetProperty("protocolVersion").GetString() ?? string.Empty,
            "Handshake must return the active protocol version.");
    }

    private static T Throws<T>(Action action)
        where T : Exception
    {
        try
        {
            action();
        }
        catch (T exception)
        {
            return exception;
        }

        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static void True(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{message} Expected: {expected}; actual: {actual}.");
        }
    }
}
