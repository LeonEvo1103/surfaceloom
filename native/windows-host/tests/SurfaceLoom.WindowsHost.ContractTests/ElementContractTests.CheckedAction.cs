using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Client;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static partial class ElementContractTests
{
    public static void SnapshotSelectorMatchingIsExact()
    {
        var locator = new UiaLocator
        {
            AutomationIds = ["send"],
            Names = ["Send", "发送"],
            ControlTypes = ["BUTTON"],
            ClassNames = ["ExpectedClass"],
            FrameworkIds = ["Chrome"],
            NativeWindowHandle = 42,
        };
        var matching = BatchSnapshot(
            "target",
            "Send",
            "send",
            className: "ExpectedClass",
            frameworkId: "Chrome",
            nativeWindowHandle: 42);
        True(UiaElementSnapshotMatcher.MatchesSelectors(locator, matching),
            "A refreshed snapshot must retain every selector group before an action.");

        foreach (var changed in new[]
                 {
                     matching with { Name = "Cancel" },
                     matching with { AutomationId = "other" },
                     matching with { ControlType = "hyperlink" },
                     matching with { ClassName = "OtherClass" },
                     matching with { FrameworkId = "Win32" },
                     matching with { NativeWindowHandle = 43 },
                 })
        {
            True(!UiaElementSnapshotMatcher.MatchesSelectors(locator, changed),
                "Changing any selector field must invalidate a refreshed action target.");
        }
        True(!UiaElementSnapshotMatcher.MatchesSelectors(
                locator with { MatchIndex = 0 },
                matching),
            "An indexed locator must never authorize a refreshed action target.");
    }

    public static void CheckedActionRequestsAreStrict()
    {
        var locator = new UiaLocator
        {
            AutomationIds = ["send"],
            Names = ["Send"],
            ControlTypes = ["button"],
            ClassNames = ["ExpectedClass"],
            FrameworkIds = ["Chrome"],
            NativeWindowHandle = 42,
        };
        var valid = new ElementActionRequest
        {
            SessionId = "session",
            ElementId = "element",
            Action = UiaAction.Invoke,
            ExpectedTarget = new UiaActionTargetExpectation
            {
                Locator = locator,
                ProcessId = 123,
                RootElementId = "root",
            },
        };
        ProtocolValidator.Validate(valid);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(valid, JsonDefaults.Options));
        var expected = json.RootElement.GetProperty("expectedTarget");
        Equal(123, expected.GetProperty("processId").GetInt32(),
            "Every action must carry its selected process identity on the wire.");
        Equal("root", expected.GetProperty("rootElementId").GetString(),
            "Every action must carry its checked search-root handle on the wire.");
        Equal("send", expected.GetProperty("locator").GetProperty("automationIds")[0].GetString(),
            "Every action must carry its complete locator expectation on the wire.");
        Equal("descendants", expected.GetProperty("locator").GetProperty("scope").GetString(),
            "The checked action wire proof must preserve locator scope.");
        Equal(SupportLevel.Supported,
            CapabilityCatalog.Create().Features["uia.checkedActionTarget"].Support,
            "Checked action targets must be discoverable.");

        foreach (var invalid in new[]
                 {
                     valid with { ExpectedTarget = null },
                     valid with
                     {
                         ExpectedTarget = valid.ExpectedTarget! with { ProcessId = 0 },
                     },
                     valid with
                     {
                         ExpectedTarget = valid.ExpectedTarget! with { RootElementId = " " },
                     },
                     valid with
                     {
                         ExpectedTarget = valid.ExpectedTarget! with { Locator = new UiaLocator() },
                     },
                     valid with
                     {
                         ExpectedTarget = valid.ExpectedTarget! with
                         {
                             Locator = locator with { MatchIndex = 0 },
                         },
                     },
                     valid with { Action = (UiaAction)999 },
                     valid with { Action = UiaAction.Unspecified },
                     valid with { Value = "unexpected" },
                     valid with { Action = UiaAction.SetValue, Value = null },
                 })
        {
            Equal("invalid_request",
                Throws<HostOperationException>(() => ProtocolValidator.Validate(invalid)).Code,
                "Malformed or under-specified action authorization must fail closed.");
        }

        ProtocolValidator.Validate(valid with { Action = UiaAction.SetValue, Value = string.Empty });
    }

    public static void CheckedActionTargetsFailClosed()
    {
        var locator = new UiaLocator
        {
            AutomationIds = ["chat-nav"],
            Names = ["Chat"],
            ControlTypes = ["button"],
            ClassNames = ["ExpectedClass"],
            FrameworkIds = ["Chrome"],
            NativeWindowHandle = 42,
        };
        var request = new ElementActionRequest
        {
            SessionId = "session",
            ElementId = "target",
            Action = UiaAction.Invoke,
            ExpectedTarget = new UiaActionTargetExpectation
            {
                Locator = locator,
                ProcessId = 123,
                RootElementId = "root",
            },
        };
        var matching = BatchSnapshot(
            "target",
            "Chat",
            "chat-nav",
            className: "ExpectedClass",
            frameworkId: "Chrome",
            nativeWindowHandle: 42);
        UiaActionTargetGuard.RequireCurrent(request, matching, [1, 2], [1, 2], [1, 2]);

        var changedTargets = new[]
        {
            matching with { ElementId = "other" },
            matching with { ProcessId = 124 },
            matching with { Name = "Send" },
            matching with { AutomationId = "send" },
            matching with { ControlType = "hyperlink" },
            matching with { ClassName = "OtherClass" },
            matching with { FrameworkId = "Win32" },
            matching with { NativeWindowHandle = 43 },
            matching with { IsOffscreen = true },
            matching with { IsEnabled = false },
            matching with { SupportedActions = Array.Empty<UiaAction>() },
        };
        foreach (var changed in changedTargets)
        {
            Equal("action_target_changed",
                Throws<HostOperationException>(() =>
                    UiaActionTargetGuard.RequireCurrent(
                        request,
                        changed,
                        [1, 2],
                        [1, 2],
                        [1, 2])).Code,
                "Any changed identity, selector, state, or pattern must reject the action.");
        }
        Equal("action_target_changed",
            Throws<HostOperationException>(() =>
                UiaActionTargetGuard.RequireCurrent(
                    request,
                    matching,
                    [1, 2],
                    [1, 3],
                    [1, 2])).Code,
            "RuntimeId reuse must reject the action before its UIA pattern is called.");

        var submissions = 0;
        UiaActionTargetGuard.SubmitIfCurrent(
            request,
            matching,
            [1, 2],
            [1, 2],
            [1, 2],
            () => submissions++);
        Equal(1, submissions, "A valid checked action target must submit exactly once.");

        submissions = 0;
        _ = Throws<HostOperationException>(() => UiaActionTargetGuard.SubmitIfCurrent(
            request,
            matching with { Name = "Send" },
            [1, 2],
            [1, 2],
            [1, 2],
            () => submissions++));
        Equal(0, submissions, "A rejected checked target must never reach its executor.");

        submissions = 0;
        var providerFailure = new InvalidOperationException("provider failure");
        var propagated = Throws<InvalidOperationException>(() =>
            UiaActionTargetGuard.SubmitIfCurrent(
                request,
                matching,
                [1, 2],
                [1, 2],
                [1, 2],
                () =>
                {
                    submissions++;
                    throw providerFailure;
                }));
        Equal(1, submissions, "A throwing UIA provider must still be called at most once.");
        True(ReferenceEquals(providerFailure, propagated),
            "The checked boundary must preserve the executor's original failure.");
    }
}
