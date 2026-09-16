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
    public static void BatchQueryIsDiscoverableAndRouted()
    {
        True(HostProtocol.Methods.Contains(HostProtocol.QueryElementBatch),
            "element.queryBatch must be advertised by the handshake.");
        Equal("element.queryBatch", HostProtocol.QueryElementBatch,
            "The batch-query wire method must remain stable.");
        Equal(SupportLevel.Supported, CapabilityCatalog.Create().Features["uia.batchQuery"].Support,
            "One-observation multi-locator queries must be advertised as supported.");

        var request = new ElementBatchQueryRequest
        {
            SessionId = "missing",
            RootElementId = "dialog",
            Clauses =
            [
                new UiaLocator
                {
                    AutomationIds = ["send"],
                    Names = ["Send"],
                    ControlTypes = ["button"],
                },
            ],
        };
        using var requestJson = JsonDocument.Parse(
            JsonSerializer.Serialize(request, JsonDefaults.Options));
        Equal("dialog", requestJson.RootElement.GetProperty("rootElementId").GetString(),
            "Batch queries must retain their one explicit scoped root.");
        Equal(1, requestJson.RootElement.GetProperty("clauses").GetArrayLength(),
            "Complete locators must be serialized as distinct clauses.");

        using var parameters = JsonDocument.Parse(
            JsonSerializer.Serialize(request with { RootElementId = null }, JsonDefaults.Options));
        using var dispatcher = new RequestDispatcher();
        var exception = Throws<HostOperationException>(() => dispatcher.Dispatch(new RpcRequest
        {
            ProtocolVersion = HostProtocol.Version,
            Id = "batch-query",
            Method = HostProtocol.QueryElementBatch,
            Parameters = parameters.RootElement.Clone(),
        }));
        Equal("session_not_found", exception.Code,
            "Dispatcher must validate and route element.queryBatch before resolving its session.");

        var result = new ElementBatchQueryResult(
        [
            new ElementBatchClauseResult(0, [BatchSnapshot("one", "Send", "send")]),
            new ElementBatchClauseResult(1, Array.Empty<ElementSnapshot>()),
        ]);
        using var resultJson = JsonDocument.Parse(JsonSerializer.Serialize(result, JsonDefaults.Options));
        var clauses = resultJson.RootElement.GetProperty("clauses");
        Equal(2, clauses.GetArrayLength(), "The response must preserve one entry per input clause.");
        Equal(0, clauses[0].GetProperty("clauseIndex").GetInt32(),
            "Each response entry must identify its input clause index.");
        Equal(1, clauses[0].GetProperty("elements").GetArrayLength(),
            "Each clause must carry its own full ElementSnapshot list.");
        Equal(0, clauses[1].GetProperty("elements").GetArrayLength(),
            "An absent clause must be represented by an empty list, not an omitted result.");
    }

    public static void BatchQueryValidationIsStrictAndBounded()
    {
        var valid = new ElementBatchQueryRequest
        {
            SessionId = "session",
            Clauses = [new UiaLocator { Names = ["Settings"] }],
        };
        ProtocolValidator.Validate(valid);

        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with { Clauses = Array.Empty<UiaLocator>() })).Code,
            "A batch with no clauses must be rejected instead of proving universal absence.");
        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with { Clauses = null! })).Code,
            "A null clause collection must be rejected.");
        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with { RootElementId = " " })).Code,
            "An empty root handle must never fall back to the session root.");
        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with
            {
                Clauses = Enumerable.Range(0, ElementBatchQueryLimits.MaxClauses + 1)
                    .Select(index => new UiaLocator { Names = [$"name-{index}"] })
                    .ToArray(),
            })).Code,
            "Clause count must have a fixed protocol limit.");
        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with { Clauses = [new UiaLocator()] })).Code,
            "Every batch clause must retain the non-empty locator contract.");
        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with
            {
                Clauses = [new UiaLocator { Names = ["Settings"], MatchIndex = 0 }],
            })).Code,
            "A batch clause must not use a single-result index.");
        Equal("invalid_request", Throws<HostOperationException>(() =>
            ProtocolValidator.Validate(valid with
            {
                Clauses =
                [
                    new UiaLocator
                    {
                        Names = ["Settings"],
                        Scope = (ElementSearchScope)int.MaxValue,
                    },
                ],
            })).Code,
            "An unknown clause scope must fail before the UIA provider is queried.");
    }

    public static void BatchQueryRetainsClauseSemantics()
    {
        var clauses = new[]
        {
            new UiaLocator
            {
                AutomationIds = ["send"],
                Names = ["Send", "发送"],
                ControlTypes = ["BUTTON"],
                Scope = ElementSearchScope.Descendants,
            },
            new UiaLocator
            {
                Names = ["Send", "发送"],
                FrameworkIds = ["Chrome"],
                Scope = ElementSearchScope.Subtree,
            },
            new UiaLocator
            {
                AutomationIds = ["send"],
                ClassNames = ["ExpectedClass"],
                NativeWindowHandle = 42,
                Scope = ElementSearchScope.Children,
            },
        };
        var candidates = new[]
        {
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("root", "Send", "send", frameworkId: "Chrome"),
                UiaBatchElementRelation.Root),
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("child", "发送", "send", className: "ExpectedClass",
                    frameworkId: "Chrome", nativeWindowHandle: 42),
                UiaBatchElementRelation.DirectChild),
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("wrong-class", "Cancel", "send", className: "OtherClass",
                    frameworkId: "Chrome", nativeWindowHandle: 42),
                UiaBatchElementRelation.DirectChild),
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("wrong-id", "Cancel", "other", className: "ExpectedClass",
                    frameworkId: "Chrome", nativeWindowHandle: 42),
                UiaBatchElementRelation.DirectChild),
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("wrong-hwnd", "Cancel", "send", className: "ExpectedClass",
                    frameworkId: "Chrome", nativeWindowHandle: 43),
                UiaBatchElementRelation.DirectChild),
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("wrong-scope", "Cancel", "send", className: "ExpectedClass",
                    frameworkId: "Chrome", nativeWindowHandle: 42),
                UiaBatchElementRelation.DeeperDescendant),
            new UiaBatchCandidateSnapshot(
                BatchSnapshot("deep", "Send", "other", frameworkId: "Chrome"),
                UiaBatchElementRelation.DeeperDescendant),
        };

        var matches = UiaElementBatchQuery.Classify(clauses, candidates);
        True(matches[0].SequenceEqual([1]),
            "OR values within selector groups and AND across groups must stay inside one clause; root scope must be excluded.");
        True(matches[1].SequenceEqual([0, 1, 6]),
            "A second complete clause must classify independently and preserve tree order.");
        True(matches[2].SequenceEqual([1]),
            "Children scope, class, AutomationId, and HWND must all be enforced together.");
        Equal(1, matches[0].Intersect(matches[1]).Count(),
            "One captured snapshot may appear in every clause it independently satisfies.");
    }

    public static void BatchQueryOutputLimitsFailClosed()
    {
        UiaElementBatchQuery.ValidateUniqueElementCount(
            ElementBatchQueryLimits.MaxUniqueElements);
        var providerCountFailure = Throws<HostOperationException>(() =>
            UiaElementBatchQuery.ValidateUniqueElementCount(
                ElementBatchQueryLimits.MaxUniqueElements + 1));
        Equal("uia_batch_result_limit", providerCountFailure.Code,
            "Provider candidate overflow must fail before the host copies the collection.");

        var locator = new UiaLocator
        {
            ControlTypes = ["button"],
            Scope = ElementSearchScope.Subtree,
        };
        var tooManyUnique = Enumerable
            .Range(0, ElementBatchQueryLimits.MaxUniqueElements + 1)
            .Select(index => new UiaBatchCandidateSnapshot(
                BatchSnapshot($"element-{index}", "Button", $"button-{index}"),
                UiaBatchElementRelation.DirectChild))
            .ToArray();
        var uniqueFailure = Throws<HostOperationException>(() =>
            UiaElementBatchQuery.Classify([locator], tooManyUnique));
        Equal("uia_batch_result_limit", uniqueFailure.Code,
            "Unique candidate overflow must fail the whole observation.");

        var boundaryCandidates = Enumerable
            .Range(0, ElementBatchQueryLimits.MaxUniqueElements)
            .Select(index => new UiaBatchCandidateSnapshot(
                BatchSnapshot($"element-{index}", "Button", $"button-{index}"),
                UiaBatchElementRelation.DirectChild))
            .ToArray();
        var boundary = UiaElementBatchQuery.Classify([locator, locator], boundaryCandidates);
        Equal(ElementBatchQueryLimits.MaxReturnedElements,
            boundary.Sum(matches => matches.Count),
            "The exact total-output boundary must remain usable.");

        var returnedFailure = Throws<HostOperationException>(() =>
            UiaElementBatchQuery.Classify([locator, locator, locator], boundaryCandidates));
        Equal("uia_batch_result_limit", returnedFailure.Code,
            "Clause-membership overflow must fail instead of truncating a positive obstruction.");
    }
}
