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
    public static void FindAllIsDiscoverable()
    {
        True(HostProtocol.Methods.Contains(HostProtocol.FindElements),
            "element.findAll must be advertised by the handshake.");
        Equal("element.findAll", HostProtocol.FindElements,
            "The find-all wire method must remain stable.");

        var features = CapabilityCatalog.Create().Features;
        Equal(SupportLevel.Supported, features["uia.findAll"].Support,
            "Multi-element queries must be advertised as supported.");
        Equal(SupportLevel.Supported, features["uia.elementState"].Support,
            "Readable UIA element state must be advertised as supported.");

        using var parameters = JsonDocument.Parse(
            "{\"sessionId\":\"missing\",\"locator\":{\"automationIds\":[\"result\"]}," +
            "\"wait\":{\"timeoutMs\":0,\"pollIntervalMs\":10}}");
        using var dispatcher = new RequestDispatcher();
        var exception = Throws<HostOperationException>(() => dispatcher.Dispatch(new RpcRequest
        {
            ProtocolVersion = HostProtocol.Version,
            Id = "find-all",
            Method = HostProtocol.FindElements,
            Parameters = parameters.RootElement.Clone(),
        }));
        Equal("session_not_found", exception.Code,
            "Dispatcher must route element.findAll before resolving its session.");
    }

    public static void FindAllReturnsEveryImmediateMatch()
    {
        var calls = 0;
        var matches = UiaPollingSearch.FindAllUntilAvailable<string>(
            () =>
            {
                calls++;
                return new[] { "first", "second" };
            },
            ZeroWait());

        Equal(1, calls, "An immediately successful query must run once.");
        Equal(2, matches.Count, "Find-all must retain every matching element.");
        Equal("first", matches[0], "Find-all must preserve UIA tree order.");
        Equal("second", matches[1], "Find-all must not collapse multiple matches.");
    }

    public static void FindAllReturnsEmptyAfterTimeout()
    {
        var calls = 0;
        var matches = UiaPollingSearch.FindAllUntilAvailable<string>(
            () =>
            {
                calls++;
                return Array.Empty<string>();
            },
            ZeroWait());

        Equal(1, calls, "A zero-timeout query must still inspect the UIA tree once.");
        Equal(0, matches.Count, "Find-all must return an empty result instead of element_not_found.");
    }

    public static void FindAllRejectsMatchIndex()
    {
        var exception = Throws<HostOperationException>(() =>
            ProtocolValidator.ValidateFindAll(new FindElementRequest
            {
                SessionId = "session",
                Locator = new UiaLocator
                {
                    AutomationIds = ["result"],
                    MatchIndex = 0,
                },
                Wait = ZeroWait(),
            }));

        Equal("invalid_request", exception.Code,
            "A single-result index must not silently narrow a find-all request.");
    }
}
