using System.Text.Json.Serialization;

namespace SurfaceLoom.WindowsHost.Protocol;

public enum ElementSearchScope
{
    Element,
    Children,
    Descendants,
    Subtree,
}

public enum UiaAction
{
    Unspecified,
    Invoke,
    SetValue,
    Toggle,
    Select,
    Expand,
    Collapse,
    Focus,
}

public enum SessionOwnership
{
    Owned,
    External,
    System,
}

public enum SessionSurface
{
    Window,
    Process,
    Desktop,
}

public sealed record WaitOptions
{
    public int TimeoutMs { get; init; } = 5_000;
    public int PollIntervalMs { get; init; } = 100;
}

public sealed record UiaLocator
{
    public IReadOnlyList<string> AutomationIds { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> Names { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> ControlTypes { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> ClassNames { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> FrameworkIds { get; init; } = Array.Empty<string>();
    public int? NativeWindowHandle { get; init; }
    public ElementSearchScope Scope { get; init; } = ElementSearchScope.Descendants;
    public int? MatchIndex { get; init; }
}

public sealed record AttachSessionRequest
{
    public int ProcessId { get; init; }
    public string Desktop { get; init; } = "default";
    public UiaLocator? Window { get; init; }
    public WaitOptions Wait { get; init; } = new();
}

public sealed record LaunchSessionRequest
{
    public string ExecutablePath { get; init; } = string.Empty;
    public IReadOnlyList<string> Arguments { get; init; } = Array.Empty<string>();
    public string? WorkingDirectory { get; init; }
    public Dictionary<string, string> Environment { get; init; } =
        new(StringComparer.OrdinalIgnoreCase);
    public string Desktop { get; init; } = "default";
    public bool WaitForWindow { get; init; } = true;
    public UiaLocator? Window { get; init; }
    public WaitOptions Wait { get; init; } = new();
}

public sealed record DesktopSessionRequest
{
    public string Desktop { get; init; } = "default";
}

public sealed record SessionRequest(string SessionId);

public sealed record ProcessEndRequest
{
    public string SessionId { get; init; } = string.Empty;
    public WaitOptions Wait { get; init; } = new() { TimeoutMs = 10_000 };
}

public sealed record SessionResult(
    string SessionId,
    int ProcessId,
    SessionOwnership Ownership,
    SessionSurface Surface,
    ElementSnapshot Root);

public sealed record ProcessEndResult(
    string SessionId,
    int ProcessId,
    string RequestedAction,
    bool Exited,
    bool WasAlreadyExited);

public sealed record FindElementRequest
{
    public string SessionId { get; init; } = string.Empty;
    public string? RootElementId { get; init; }
    public UiaLocator Locator { get; init; } = new();
    public WaitOptions Wait { get; init; } = new();
}

public static class ElementBatchQueryLimits
{
    public const int MaxClauses = 32;
    public const int MaxUniqueElements = 512;
    public const int MaxReturnedElements = 1_024;
}

public sealed record ElementBatchQueryRequest
{
    public string SessionId { get; init; } = string.Empty;
    public string? RootElementId { get; init; }
    public IReadOnlyList<UiaLocator> Clauses { get; init; } = Array.Empty<UiaLocator>();
}

public sealed record ElementBatchClauseResult(
    int ClauseIndex,
    IReadOnlyList<ElementSnapshot> Elements);

public sealed record ElementBatchQueryResult(
    IReadOnlyList<ElementBatchClauseResult> Clauses);

public sealed record ElementRequest(string SessionId, string ElementId);

public sealed record UiaActionTargetExpectation
{
    public UiaLocator Locator { get; init; } = new();
    public int ProcessId { get; init; }
    public string RootElementId { get; init; } = string.Empty;
}

public sealed record ElementActionRequest
{
    public string SessionId { get; init; } = string.Empty;
    public string ElementId { get; init; } = string.Empty;
    public UiaAction Action { get; init; }
    public string? Value { get; init; }
    public UiaActionTargetExpectation? ExpectedTarget { get; init; }
}

public sealed record ElementSnapshot(
    string ElementId,
    string Name,
    string AutomationId,
    string ControlType,
    string ClassName,
    string FrameworkId,
    int ProcessId,
    int NativeWindowHandle,
    bool IsEnabled,
    bool IsOffscreen,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Value,
    bool HasKeyboardFocus,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] bool? IsSelected,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ToggleState,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ExpandCollapseState,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? AriaRole,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? AriaProperties,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] bool? IsReadOnly,
    IReadOnlyList<UiaAction> SupportedActions);
