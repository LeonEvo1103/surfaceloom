using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

internal enum UiaBatchElementRelation
{
    Root,
    DirectChild,
    DeeperDescendant,
}

internal sealed record UiaBatchCandidateSnapshot(
    ElementSnapshot Snapshot,
    UiaBatchElementRelation Relation);

internal sealed record UiaBatchObservation(
    IReadOnlyList<StableElementObservation<AutomationElement, ElementSnapshot>> Elements,
    IReadOnlyList<IReadOnlyList<int>> MatchIndexesByClause);

internal static partial class UiaElementBatchQuery
{
    private const string UnregisteredElementId = "batch-unregistered";

    public static UiaBatchObservation Observe(
        AutomationElement root,
        IReadOnlyList<UiaLocator> clauses,
        int? restrictToProcessId)
    {
        ArgumentNullException.ThrowIfNull(root);
        ValidateClauses(clauses);

        var rootRuntimeId = UiaElementIdentity.ReadRuntimeId(root);
        var candidates = QueryOnce(root, clauses, restrictToProcessId);
        ValidateUniqueElementCount(candidates.Count);

        if (candidates.Count == 0)
        {
            if (!rootRuntimeId.AsSpan().SequenceEqual(UiaElementIdentity.ReadRuntimeId(root)))
            {
                throw ObservationChanged();
            }
            return new UiaBatchObservation(
                Array.Empty<StableElementObservation<AutomationElement, ElementSnapshot>>(),
                clauses.Select(_ => (IReadOnlyList<int>)Array.Empty<int>()).ToArray());
        }

        var observed = new List<StableElementObservation<AutomationElement, ElementSnapshot>>(
            candidates.Count);
        var classified = new List<UiaBatchCandidateSnapshot>(candidates.Count);
        var runtimeIds = new HashSet<int[]>(RuntimeIdComparer.Instance);

        foreach (var candidate in candidates)
        {
            var observation = StableElementObservationTransaction.Capture(
                candidate,
                UiaElementIdentity.ReadRuntimeId,
                element => UiaElementSnapshotter.Create(UnregisteredElementId, element),
                ObservationChanged);
            var runtimeId = observation.RuntimeId;
            if (!runtimeIds.Add(runtimeId))
            {
                throw new HostOperationException(
                    "uia_batch_duplicate_identity",
                    "The UIA provider returned one RuntimeId more than once in a batch observation; the host will not return a torn result.");
            }

            // Capture the complete protocol snapshot exactly once.  Classification below uses
            // only this captured state, so clauses cannot observe different values for one element.
            var snapshot = observation.Snapshot;
            var selectorMatches = clauses
                .Select(locator => MatchesSelectors(locator, snapshot))
                .ToArray();
            if (!selectorMatches.Any(match => match))
            {
                throw new HostOperationException(
                    "uia_batch_observation_changed",
                    "A UIA candidate changed after the shared tree query; the host will not treat the partial observation as successful absence.");
            }

            var relation = RuntimeIdComparer.Instance.Equals(runtimeId, rootRuntimeId)
                ? UiaBatchElementRelation.Root
                : RequiresDirectChildCheck(clauses, selectorMatches)
                    ? ReadDescendantRelation(rootRuntimeId, candidate)
                    : UiaBatchElementRelation.DeeperDescendant;
            observed.Add(observation);
            classified.Add(new UiaBatchCandidateSnapshot(snapshot, relation));
        }

        var rawIndexesByClause = Classify(clauses, classified);
        var usedRawIndexes = rawIndexesByClause
            .SelectMany(indexes => indexes)
            .Distinct()
            .OrderBy(index => index)
            .ToArray();
        var compactIndexByRawIndex = usedRawIndexes
            .Select((rawIndex, compactIndex) => (rawIndex, compactIndex))
            .ToDictionary(pair => pair.rawIndex, pair => pair.compactIndex);
        var compactElements = usedRawIndexes.Select(index => observed[index]).ToArray();
        var compactIndexesByClause = rawIndexesByClause
            .Select(indexes => (IReadOnlyList<int>)indexes
                .Select(index => compactIndexByRawIndex[index])
                .ToArray())
            .ToArray();

        StableElementObservationTransaction.ValidateAndCommit(
            compactElements,
            UiaElementIdentity.ReadRuntimeId,
            ObservationChanged,
            elements => elements);
        if (!rootRuntimeId.AsSpan().SequenceEqual(UiaElementIdentity.ReadRuntimeId(root)))
        {
            throw ObservationChanged();
        }
        return new UiaBatchObservation(compactElements, compactIndexesByClause);
    }

}
