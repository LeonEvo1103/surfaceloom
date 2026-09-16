using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

internal static partial class UiaElementBatchQuery
{
    internal static IReadOnlyList<IReadOnlyList<int>> Classify(
        IReadOnlyList<UiaLocator> clauses,
        IReadOnlyList<UiaBatchCandidateSnapshot> candidates)
    {
        ValidateClauses(clauses);
        ArgumentNullException.ThrowIfNull(candidates);
        ValidateUniqueElementCount(candidates.Count);

        var matches = clauses.Select(_ => new List<int>()).ToArray();
        var returned = 0;
        for (var candidateIndex = 0; candidateIndex < candidates.Count; candidateIndex++)
        {
            var candidate = candidates[candidateIndex] ??
                throw new ArgumentException("Batch candidates must not contain null values.", nameof(candidates));
            for (var clauseIndex = 0; clauseIndex < clauses.Count; clauseIndex++)
            {
                var locator = clauses[clauseIndex];
                if (!Matches(locator, candidate.Snapshot, candidate.Relation))
                {
                    continue;
                }

                returned++;
                if (returned > ElementBatchQueryLimits.MaxReturnedElements)
                {
                    throw LimitExceeded(
                        "returnedElements",
                        returned,
                        ElementBatchQueryLimits.MaxReturnedElements);
                }
                matches[clauseIndex].Add(candidateIndex);
            }
        }

        return matches.Select(match => (IReadOnlyList<int>)match.ToArray()).ToArray();
    }

    internal static bool Matches(
        UiaLocator locator,
        ElementSnapshot snapshot,
        UiaBatchElementRelation relation) =>
        MatchesSelectors(locator, snapshot) && MatchesScope(locator.Scope, relation);

    internal static bool MatchesSelectors(UiaLocator locator, ElementSnapshot snapshot)
        => UiaActionTargetGuard.MatchesSelectors(locator, snapshot);

    internal static void ValidateUniqueElementCount(int observed)
    {
        if (observed > ElementBatchQueryLimits.MaxUniqueElements)
        {
            throw LimitExceeded(
                "uniqueElements",
                observed,
                ElementBatchQueryLimits.MaxUniqueElements);
        }
    }

    private static bool RequiresDirectChildCheck(
        IReadOnlyList<UiaLocator> clauses,
        IReadOnlyList<bool> selectorMatches)
    {
        for (var index = 0; index < clauses.Count; index++)
        {
            if (selectorMatches[index] && clauses[index].Scope == ElementSearchScope.Children)
            {
                return true;
            }
        }
        return false;
    }

    private static bool MatchesScope(
        ElementSearchScope scope,
        UiaBatchElementRelation relation) => scope switch
        {
            ElementSearchScope.Element => relation == UiaBatchElementRelation.Root,
            ElementSearchScope.Children => relation == UiaBatchElementRelation.DirectChild,
            ElementSearchScope.Descendants => relation != UiaBatchElementRelation.Root,
            ElementSearchScope.Subtree => true,
            _ => throw new HostOperationException(
                "invalid_request",
                $"Unknown element search scope '{scope}'."),
        };

    private static void ValidateClauses(IReadOnlyList<UiaLocator> clauses)
    {
        ArgumentNullException.ThrowIfNull(clauses);
        ProtocolValidator.Validate(new ElementBatchQueryRequest
        {
            SessionId = "internal-batch-query",
            Clauses = clauses,
        });
    }

    private static HostOperationException LimitExceeded(
        string dimension,
        int observed,
        int limit) => new(
            "uia_batch_result_limit",
            "The batch UIA observation exceeded a fixed output limit; no partial result was returned.",
            new { dimension, observed, limit });
}
