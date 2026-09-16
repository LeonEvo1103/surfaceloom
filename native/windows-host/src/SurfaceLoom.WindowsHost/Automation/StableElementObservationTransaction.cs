namespace SurfaceLoom.WindowsHost.Automation;

internal sealed record StableElementObservation<TElement, TSnapshot>(
    TElement Element,
    int[] RuntimeId,
    TSnapshot Snapshot)
    where TElement : class;

/// <summary>
/// Keeps provider reads outside the handle-registry commit boundary. A caller receives no
/// opportunity to publish handles until every snapshot has a stable RuntimeId and a final
/// identity pass succeeds for the complete result set.
/// </summary>
internal static class StableElementObservationTransaction
{
    public static StableElementObservation<TElement, TSnapshot> Capture<TElement, TSnapshot>(
        TElement element,
        Func<TElement, int[]> readRuntimeId,
        Func<TElement, TSnapshot> captureSnapshot,
        Func<Exception> changed)
        where TElement : class
    {
        ArgumentNullException.ThrowIfNull(element);
        ArgumentNullException.ThrowIfNull(readRuntimeId);
        ArgumentNullException.ThrowIfNull(captureSnapshot);
        ArgumentNullException.ThrowIfNull(changed);

        var before = readRuntimeId(element);
        var snapshot = captureSnapshot(element);
        var after = readRuntimeId(element);
        if (!before.AsSpan().SequenceEqual(after))
        {
            throw changed();
        }
        return new StableElementObservation<TElement, TSnapshot>(
            element,
            after.ToArray(),
            snapshot);
    }

    public static TResult ValidateAndCommit<TElement, TSnapshot, TResult>(
        IReadOnlyList<StableElementObservation<TElement, TSnapshot>> observations,
        Func<TElement, int[]> readRuntimeId,
        Func<Exception> changed,
        Func<IReadOnlyList<StableElementObservation<TElement, TSnapshot>>, TResult> commit)
        where TElement : class
    {
        ArgumentNullException.ThrowIfNull(observations);
        ArgumentNullException.ThrowIfNull(readRuntimeId);
        ArgumentNullException.ThrowIfNull(changed);
        ArgumentNullException.ThrowIfNull(commit);

        foreach (var observation in observations)
        {
            ArgumentNullException.ThrowIfNull(observation);
            if (!observation.RuntimeId.AsSpan().SequenceEqual(
                    readRuntimeId(observation.Element)))
            {
                throw changed();
            }
        }
        return commit(observations);
    }

    public static TResult CaptureAndCommit<TElement, TSnapshot, TResult>(
        IReadOnlyList<TElement> elements,
        Func<TElement, int[]> readRuntimeId,
        Func<TElement, TSnapshot> captureSnapshot,
        Func<Exception> changed,
        Func<IReadOnlyList<StableElementObservation<TElement, TSnapshot>>, TResult> commit)
        where TElement : class
    {
        ArgumentNullException.ThrowIfNull(elements);
        var observations = elements
            .Select(element => Capture(element, readRuntimeId, captureSnapshot, changed))
            .ToArray();
        return ValidateAndCommit(observations, readRuntimeId, changed, commit);
    }
}
