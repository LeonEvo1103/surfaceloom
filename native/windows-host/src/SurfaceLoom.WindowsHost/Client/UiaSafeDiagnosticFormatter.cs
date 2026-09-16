using System.Text.Json;

namespace SurfaceLoom.WindowsHost.Client;

/// <summary>
/// Only values explicitly listed here may appear as plaintext. Do not automatically pass every
/// locator constraint: locators can contain user text, paths, account names, or transcript data.
/// </summary>
public sealed record UiaSafeLocatorConstraints(
    string Key,
    IReadOnlyList<string> SafeNames,
    IReadOnlyList<string> SafeAutomationIds,
    IReadOnlyList<string> SafeClassNames);

public sealed record UiaSafeCandidate(
    string Name,
    string AutomationId,
    string ControlType,
    string ClassName,
    bool IsEnabled,
    bool IsOffscreen,
    string? AriaRole = null,
    IReadOnlyList<string>? SupportedActions = null);

public static class UiaSafeDiagnosticFormatter
{
    public const int CandidateLimit = 8;
    public const int MaxOutputCharacters = 4_096;
    public const string Redacted = "<redacted>";

    private const int MaxPlaintextCharacters = 96;
    private static readonly HashSet<string> KnownControlTypes = new(
        [
            "button", "calendar", "checkBox", "comboBox", "custom", "dataGrid", "dataItem",
            "document", "edit", "group", "header", "headerItem", "hyperlink", "image", "list",
            "listItem", "menu", "menuBar", "menuItem", "pane", "progressBar", "radioButton",
            "scrollBar", "separator", "slider", "spinner", "splitButton", "statusBar", "tab",
            "tabItem", "table", "text", "thumb", "titleBar", "toolBar", "toolTip", "tree",
            "treeItem", "window",
        ],
        StringComparer.Ordinal);
    private static readonly HashSet<string> KnownAriaRoles = new(
        [
            "button", "checkbox", "dialog", "heading", "link", "menu", "menuitem", "navigation",
            "radio", "searchbox", "tab", "tabpanel", "textbox",
        ],
        StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<string> KnownActions = new(
        ["invoke", "setValue", "select", "toggle", "expand", "collapse", "scrollIntoView"],
        StringComparer.Ordinal);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static string Format(
        UiaSafeLocatorConstraints locator,
        string errorCode,
        int postFailureExactCandidateCount,
        IEnumerable<UiaSafeCandidate> candidates)
    {
        ArgumentNullException.ThrowIfNull(locator);
        ArgumentNullException.ThrowIfNull(candidates);
        ValidateSafeValues(locator.SafeNames, nameof(locator.SafeNames));
        ValidateSafeValues(locator.SafeAutomationIds, nameof(locator.SafeAutomationIds));
        ValidateSafeValues(locator.SafeClassNames, nameof(locator.SafeClassNames));
        if (postFailureExactCandidateCount < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(postFailureExactCandidateCount),
                "The exact post-failure candidate count cannot be negative.");
        }

        var safeCandidates = candidates
            .Take(Math.Min(CandidateLimit, postFailureExactCandidateCount))
            .Select(candidate => SanitizeCandidate(locator, candidate))
            .ToList();

        while (true)
        {
            var diagnostic = new DiagnosticEnvelope(
                Schema: "surfaceloom.uia.locator-diagnostic.v1",
                LocatorKey: SafeIdentifierOrRedacted(locator.Key),
                ErrorCode: SafeIdentifierOrRedacted(errorCode),
                PostFailureExactCandidateCount: postFailureExactCandidateCount,
                ReportedCandidateCount: safeCandidates.Count,
                CandidatesTruncated: postFailureExactCandidateCount > safeCandidates.Count,
                Candidates: safeCandidates);
            var json = JsonSerializer.Serialize(diagnostic, JsonOptions);
            if (json.Length <= MaxOutputCharacters)
            {
                return json;
            }
            if (safeCandidates.Count == 0)
            {
                throw new InvalidOperationException(
                    "The bounded UIA diagnostic envelope exceeded its size contract.");
            }
            safeCandidates.RemoveAt(safeCandidates.Count - 1);
        }
    }

    private static SafeCandidate SanitizeCandidate(
        UiaSafeLocatorConstraints locator,
        UiaSafeCandidate candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        return new SafeCandidate(
            Name: ExplicitlySafeOrRedacted(candidate.Name, locator.SafeNames),
            AutomationId: ExplicitlySafeOrRedacted(
                candidate.AutomationId,
                locator.SafeAutomationIds),
            ClassName: ExplicitlySafeOrRedacted(candidate.ClassName, locator.SafeClassNames),
            Type: KnownControlTypes.Contains(candidate.ControlType)
                ? candidate.ControlType
                : Redacted,
            Enabled: candidate.IsEnabled,
            Offscreen: candidate.IsOffscreen,
            AriaRole: KnownAriaRoles.Contains(candidate.AriaRole ?? string.Empty)
                ? candidate.AriaRole
                : string.IsNullOrEmpty(candidate.AriaRole) ? string.Empty : Redacted,
            Actions: (candidate.SupportedActions ?? Array.Empty<string>())
                .Where(KnownActions.Contains)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .Take(8)
                .ToArray());
    }

    private static string ExplicitlySafeOrRedacted(
        string? value,
        IReadOnlyList<string> safeValues)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return safeValues.Contains(value, StringComparer.Ordinal) ? value : Redacted;
    }

    private static string SafeIdentifierOrRedacted(string? value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return value.Length <= MaxPlaintextCharacters &&
            value.All(character =>
                char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-')
                    ? value
                    : Redacted;
    }

    private static void ValidateSafeValues(IReadOnlyList<string> values, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(values, parameterName);
        if (values.Any(value =>
                string.IsNullOrEmpty(value) ||
                value.Length > MaxPlaintextCharacters ||
                LooksLikePath(value) ||
                value.Any(char.IsControl)))
        {
            throw new ArgumentException(
                "Explicitly safe UIA diagnostic values must be short, non-path static labels.",
                parameterName);
        }
    }

    private static bool LooksLikePath(string value) =>
        value.Contains('/', StringComparison.Ordinal) ||
        value.Contains('\\', StringComparison.Ordinal) ||
        value.Contains(":\\", StringComparison.Ordinal) ||
        value.Contains(":/", StringComparison.Ordinal) ||
        value.Contains("file://", StringComparison.OrdinalIgnoreCase);

    private sealed record DiagnosticEnvelope(
        string Schema,
        string LocatorKey,
        string ErrorCode,
        int PostFailureExactCandidateCount,
        int ReportedCandidateCount,
        bool CandidatesTruncated,
        IReadOnlyList<SafeCandidate> Candidates);

    private sealed record SafeCandidate(
        string Name,
        string AutomationId,
        string ClassName,
        string Type,
        bool Enabled,
        bool Offscreen,
        string? AriaRole,
        IReadOnlyList<string> Actions);
}
