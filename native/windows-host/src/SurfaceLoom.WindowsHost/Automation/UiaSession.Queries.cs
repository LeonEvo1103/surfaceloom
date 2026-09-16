using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public sealed partial class UiaSession
{
    public ElementSnapshot Find(
        UiaLocator locator,
        WaitOptions wait,
        string? rootElementId = null)
    {
        ThrowIfDisposed();
        var searchRoot = ResolveSearchRoot(rootElementId);
        var match = UiaElementFinder.FindOne(
            searchRoot.Element,
            locator,
            wait,
            RestrictedProcessId);
        return Remember(match, () => RequireCurrentIdentity(searchRoot));
    }

    public IReadOnlyList<ElementSnapshot> FindAll(
        UiaLocator locator,
        WaitOptions wait,
        string? rootElementId = null)
    {
        ThrowIfDisposed();
        var searchRoot = ResolveSearchRoot(rootElementId);
        var matches = UiaElementFinder.FindAll(
            searchRoot.Element,
            locator,
            wait,
            RestrictedProcessId)
            .ToArray();
        return StableElementObservationTransaction.CaptureAndCommit(
            matches,
            UiaElementIdentity.ReadRuntimeId,
            candidate => UiaElementSnapshotter.Create("unregistered", candidate),
            ObservationChanged,
            observations =>
            {
                RequireCurrentIdentity(searchRoot);
                return CommitMany(observations);
            });
    }

    public ElementBatchQueryResult QueryBatch(
        IReadOnlyList<UiaLocator> clauses,
        string? rootElementId = null)
    {
        ThrowIfDisposed();
        var searchRoot = ResolveSearchRoot(rootElementId);
        var observation = UiaElementBatchQuery.Observe(
            searchRoot.Element,
            clauses,
            RestrictedProcessId);

        var snapshots = StableElementObservationTransaction.ValidateAndCommit(
            observation.Elements,
            UiaElementIdentity.ReadRuntimeId,
            ObservationChanged,
            observations =>
            {
                RequireCurrentIdentity(searchRoot);
                return CommitMany(observations);
            });
        var results = observation.MatchIndexesByClause
            .Select((indexes, clauseIndex) => new ElementBatchClauseResult(
                clauseIndex,
                indexes.Select(index => snapshots[index]).ToArray()))
            .ToArray();
        return new ElementBatchQueryResult(results);
    }

    private IReadOnlyList<ElementSnapshot> CommitMany(
        IReadOnlyList<StableElementObservation<AutomationElement, ElementSnapshot>> observations)
    {
        var entries = observations
            .Select(observation => (
                RuntimeId: (IReadOnlyList<int>)observation.RuntimeId,
                Element: observation.Element))
            .ToArray();
        if (!elements.TryRememberBatch(entries, out var elementIds))
        {
            throw new HostOperationException(
                "element_handle_limit",
                $"The session cannot atomically remember this result within its {ElementHandleLimit}-element limit.",
                new { limit = ElementHandleLimit, requested = entries.Length });
        }
        return observations.Select((observation, index) =>
            observation.Snapshot with { ElementId = elementIds[index] }).ToArray();
    }
}
