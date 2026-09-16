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
    public static void ElementScopedFindContractIsStable()
    {
        var features = CapabilityCatalog.Create().Features;
        Equal(SupportLevel.Supported, features["uia.elementScopedFind"].Support,
            "Element-scoped queries must be advertised as supported.");
        Equal(SupportLevel.Supported, features["uia.stableElementHandles"].Support,
            "Bounded RuntimeId-backed handles must be advertised as supported.");

        var request = new FindElementRequest
        {
            SessionId = "session",
            RootElementId = "dialog",
            Locator = new UiaLocator { AutomationIds = ["1"] },
            Wait = ZeroWait(),
        };
        ProtocolValidator.Validate(request);
        ProtocolValidator.ValidateFindAll(request);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(request, JsonDefaults.Options));
        Equal("dialog", json.RootElement.GetProperty("rootElementId").GetString(),
            "The optional scoped-root handle must have a stable wire name.");

        var exception = Throws<HostOperationException>(() => ProtocolValidator.Validate(request with
        {
            RootElementId = " ",
        }));
        Equal("invalid_request", exception.Code,
            "An empty scoped-root handle must not fall back to the session root.");
    }

    public static void ElementHandlesReuseIdentityAndStayBounded()
    {
        var registry = new ElementHandleRegistry<object>(capacity: 2);
        var first = new object();
        var replacement = new object();

        True(registry.TryRemember([1, 2], first, out var firstId),
            "The first runtime identity must be remembered.");
        True(registry.TryRemember([1, 2], replacement, out var repeatedId),
            "A repeated runtime identity must refresh its reference.");
        Equal(firstId, repeatedId, "A repeated runtime identity must reuse its element handle.");
        Equal(1, registry.Count, "Repeated remember calls must not grow the handle registry.");
        True(registry.TryResolve(firstId, out var resolved) && ReferenceEquals(replacement, resolved),
            "A reused handle must resolve to the latest UIA reference.");
        True(registry.TryResolve(firstId, out _, out var rememberedRuntimeId) &&
             rememberedRuntimeId!.SequenceEqual([1, 2]),
            "A reused handle must retain its original RuntimeId proof.");
        var callerCopy = rememberedRuntimeId!.ToArray();
        callerCopy[0] = 99;
        True(registry.TryResolve(firstId, out _, out rememberedRuntimeId) &&
             rememberedRuntimeId!.SequenceEqual([1, 2]),
            "RuntimeId proofs returned to callers must not mutate the registry.");

        True(registry.TryRemember([3], new object(), out _),
            "The registry must accept distinct identities up to its limit.");
        True(!registry.TryRemember([4], new object(), out _),
            "The registry must fail closed instead of evicting or growing past its limit.");
        Equal(2, registry.Count, "A rejected identity must not change the bounded registry.");
        True(registry.TryResolve(firstId, out _),
            "Reaching the limit must not invalidate an existing scoped root handle.");

        var batchRegistry = new ElementHandleRegistry<object>(capacity: 3);
        var original = new object();
        True(batchRegistry.TryRemember([10], original, out var originalId),
            "The batch fixture must start with one remembered identity.");
        var rejectedReplacement = new object();
        True(!batchRegistry.TryRememberBatch(
                [
                    ((IReadOnlyList<int>)[10], rejectedReplacement),
                    ((IReadOnlyList<int>)[20], new object()),
                    ((IReadOnlyList<int>)[30], new object()),
                    ((IReadOnlyList<int>)[40], new object()),
                ],
                out var rejectedIds),
            "A batch that needs too many new handles must fail before mutation.");
        Equal(0, rejectedIds.Count, "A rejected batch must return no partial handles.");
        Equal(1, batchRegistry.Count, "A rejected batch must add zero new handles.");
        True(batchRegistry.TryResolve(originalId, out var afterRejectedBatch) &&
             ReferenceEquals(afterRejectedBatch, original),
            "A rejected batch must not even partially refresh an existing identity.");

        var acceptedReplacement = new object();
        var repeatedNewFirst = new object();
        var repeatedNewLast = new object();
        True(batchRegistry.TryRememberBatch(
                [
                    ((IReadOnlyList<int>)[10], acceptedReplacement),
                    ((IReadOnlyList<int>)[20], repeatedNewFirst),
                    ((IReadOnlyList<int>)[20], repeatedNewLast),
                    ((IReadOnlyList<int>)[30], new object()),
                ],
                out var acceptedIds),
            "Existing and repeated RuntimeIds must not consume additional capacity.");
        Equal(4, acceptedIds.Count, "A successful batch must preserve entry order and cardinality.");
        Equal(originalId, acceptedIds[0], "An existing RuntimeId must reuse its handle.");
        Equal(acceptedIds[1], acceptedIds[2],
            "A RuntimeId repeated within one batch must reuse one new handle.");
        Equal(3, batchRegistry.Count,
            "One existing and two distinct new RuntimeIds must exactly fill capacity three.");
        True(batchRegistry.TryResolve(originalId, out var refreshedExisting) &&
             ReferenceEquals(refreshedExisting, acceptedReplacement),
            "A successful batch must refresh the existing RuntimeId reference.");
        True(batchRegistry.TryResolve(acceptedIds[1], out var refreshedRepeated) &&
             ReferenceEquals(refreshedRepeated, repeatedNewLast),
            "The final occurrence of a repeated RuntimeId must own the refreshed reference.");
        batchRegistry.Clear();
        Equal(0, batchRegistry.Count, "Clearing a registry must remove every element handle.");
        True(!batchRegistry.TryResolve(originalId, out _, out _),
            "Clearing a registry must also remove its reverse RuntimeId proof.");
    }

    public static void SnapshotFieldsHaveStableJsonShape()
    {
        var unsupported = Snapshot();
        using var unsupportedJson = JsonDocument.Parse(
            JsonSerializer.Serialize(unsupported, JsonDefaults.Options));
        var root = unsupportedJson.RootElement;

        Equal(JsonValueKind.Null, root.GetProperty("value").ValueKind,
            "Unsupported ValuePattern must serialize value as null.");
        True(!root.GetProperty("hasKeyboardFocus").GetBoolean(),
            "Keyboard focus must be a non-null base UIA property.");
        foreach (var property in new[]
                 {
                     "isSelected", "toggleState", "expandCollapseState", "ariaRole",
                     "ariaProperties", "isReadOnly",
                 })
        {
            Equal(JsonValueKind.Null, root.GetProperty(property).ValueKind,
                $"Unsupported optional field {property} must serialize explicitly as null.");
        }

        var supported = Snapshot(
            value: "draft",
            hasKeyboardFocus: true,
            isSelected: true,
            toggleState: "on",
            expandCollapseState: "partiallyExpanded",
            ariaRole: "textbox",
            ariaProperties: "multiline=true",
            isReadOnly: false);
        using var supportedJson = JsonDocument.Parse(
            JsonSerializer.Serialize(supported, JsonDefaults.Options));
        var state = supportedJson.RootElement;
        Equal("draft", state.GetProperty("value").GetString(), "Readable value must be serialized.");
        Equal("on", state.GetProperty("toggleState").GetString(), "Toggle state must be stable.");
        Equal("partiallyExpanded", state.GetProperty("expandCollapseState").GetString(),
            "Expand/collapse state must be stable.");
        Equal("textbox", state.GetProperty("ariaRole").GetString(), "ARIA role must be serialized.");
        True(!state.GetProperty("isReadOnly").GetBoolean(), "Writable ValuePattern state must be retained.");
    }

    public static void LiveElementScopesAlwaysReresolve()
    {
        var resolutions = 0;
        var scope = new UiaLiveElementScope(() => Candidate($"owner-{++resolutions}"));
        var first = scope.Resolve();
        var second = scope.Resolve();
        Equal(2, resolutions, "Every scoped operation must invoke the owner resolver.");
        Equal("owner-1", first.ElementId, "The first scope resolution must be returned directly.");
        Equal("owner-2", second.ElementId,
            "A live scope must not cache a prior UIA element handle.");

        _ = Throws<ArgumentNullException>(() => new UiaLiveElementScope(null!));
        _ = Throws<InvalidOperationException>(() =>
            new UiaLiveElementScope(() => null!).Resolve());
        _ = Throws<InvalidOperationException>(() =>
            new UiaLiveElementScope(() => Candidate(" ")).Resolve());
    }
}
