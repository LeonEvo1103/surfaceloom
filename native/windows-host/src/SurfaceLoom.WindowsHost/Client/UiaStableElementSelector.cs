using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Client;

/// <summary>
/// Client-side semantic filters applied after an exact host query. Empty state lists mean
/// "do not filter". The policy is copied and validated by each selector before use.
/// </summary>
public sealed record UiaElementSelectionPolicy
{
    public bool RequireVisible { get; init; } = true;
    public bool RequireEnabled { get; init; }
    public bool? IsReadOnly { get; init; }
    public bool? IsSelected { get; init; }
    public IReadOnlyList<string> AriaRoles { get; init; } = Array.Empty<string>();
    /// <summary>
    /// Allows a null ARIA role only when the provider reports the optional UIA property as
    /// unsupported. A non-null role must still match <see cref="AriaRoles"/> exactly.
    /// </summary>
    public bool AllowMissingAriaRole { get; init; }
    public IReadOnlyList<UiaAction> AnySupportedActions { get; init; } = Array.Empty<UiaAction>();
    public IReadOnlyList<string> ToggleStates { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> ExpandCollapseStates { get; init; } = Array.Empty<string>();
    public int StableObservations { get; init; } = 2;

    internal UiaElementSelectionPolicy ValidatedCopy()
    {
        if (StableObservations < 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(StableObservations),
                "Stable observations must be positive.");
        }
        ArgumentNullException.ThrowIfNull(AriaRoles);
        ArgumentNullException.ThrowIfNull(AnySupportedActions);
        ArgumentNullException.ThrowIfNull(ToggleStates);
        ArgumentNullException.ThrowIfNull(ExpandCollapseStates);
        return this with
        {
            AriaRoles = AriaRoles.ToArray(),
            AnySupportedActions = AnySupportedActions.ToArray(),
            ToggleStates = ToggleStates.ToArray(),
            ExpandCollapseStates = ExpandCollapseStates.ToArray(),
        };
    }

    internal bool Matches(ElementSnapshot candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        return (!RequireVisible || !candidate.IsOffscreen) &&
            (!RequireEnabled || candidate.IsEnabled) &&
            (IsReadOnly is null || candidate.IsReadOnly == IsReadOnly) &&
            (IsSelected is null || candidate.IsSelected == IsSelected) &&
            MatchesAriaRole(candidate.AriaRole) &&
            (AnySupportedActions.Count == 0 ||
             AnySupportedActions.Any(candidate.SupportedActions.Contains)) &&
            MatchesText(ToggleStates, candidate.ToggleState) &&
            MatchesText(ExpandCollapseStates, candidate.ExpandCollapseState);
    }

    private static bool MatchesText(IReadOnlyList<string> expected, string? actual) =>
        expected.Count == 0 ||
        expected.Contains(actual ?? string.Empty, StringComparer.OrdinalIgnoreCase);

    private bool MatchesAriaRole(string? actual) =>
        AriaRoles.Count == 0 ||
        (actual is null && AllowMissingAriaRole) ||
        AriaRoles.Contains(actual ?? string.Empty, StringComparer.OrdinalIgnoreCase);
}

/// <summary>
/// Proves that exactly one eligible RuntimeId-backed element remains the same across
/// consecutive observations. Ambiguity, disappearance, or identity churn resets evidence.
/// </summary>
public sealed class UiaStableElementSelector
{
    private readonly UiaElementSelectionPolicy policy;
    private string? candidateId;
    private int observations;

    public UiaStableElementSelector(UiaElementSelectionPolicy? policy = null)
    {
        this.policy = (policy ?? new UiaElementSelectionPolicy()).ValidatedCopy();
    }

    public IReadOnlyList<ElementSnapshot> Eligible(IReadOnlyList<ElementSnapshot> candidates)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        return candidates.Where(policy.Matches).ToArray();
    }

    public bool Observe(
        IReadOnlyList<ElementSnapshot> candidates,
        out ElementSnapshot? stableCandidate)
    {
        var eligible = Eligible(candidates);
        stableCandidate = null;
        if (eligible.Count != 1 || string.IsNullOrWhiteSpace(eligible[0].ElementId))
        {
            Reset();
            return false;
        }

        var current = eligible[0];
        if (string.Equals(candidateId, current.ElementId, StringComparison.Ordinal))
        {
            observations++;
        }
        else
        {
            candidateId = current.ElementId;
            observations = 1;
        }

        if (observations < policy.StableObservations)
        {
            return false;
        }

        stableCandidate = current;
        return true;
    }

    public void Reset()
    {
        candidateId = null;
        observations = 0;
    }
}

/// <summary>
/// Proves disappearance only after consecutive successful zero-eligible observations.
/// Callers must invoke Reset when a query itself is indeterminate.
/// </summary>
public sealed class UiaStableAbsenceSelector
{
    private readonly UiaStableElementSelector selector;
    private readonly int requiredObservations;
    private int observations;

    public UiaStableAbsenceSelector(
        UiaElementSelectionPolicy? policy = null,
        int requiredObservations = 3)
    {
        if (requiredObservations < 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(requiredObservations),
                "Stable absence observations must be positive.");
        }
        selector = new UiaStableElementSelector(policy);
        this.requiredObservations = requiredObservations;
    }

    public bool Observe(IReadOnlyList<ElementSnapshot> candidates)
    {
        observations = selector.Eligible(candidates).Count == 0 ? observations + 1 : 0;
        return observations >= requiredObservations;
    }

    public void Reset()
    {
        observations = 0;
        selector.Reset();
    }
}
