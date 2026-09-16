using SurfaceLoom.WindowsHost.Automation;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class StableObservationTransactionContractTests
{
    private sealed class Candidate
    {
        public int Identity { get; set; }
    }

    public static void FailuresNeverReachHandleCommit()
    {
        var candidate = new Candidate { Identity = 1 };
        var commits = 0;
        _ = Throws<InvalidOperationException>(() =>
            StableElementObservationTransaction.CaptureAndCommit<Candidate, string, int>(
                new[] { candidate },
                item => [item.Identity],
                _ => throw new InvalidOperationException("snapshot failed"),
                () => new InvalidOperationException("identity changed"),
                observations =>
                {
                    commits++;
                    return observations.Count;
                }));
        Equal(0, commits, "Snapshot failure must occur before the commit callback.");

        _ = Throws<InvalidOperationException>(() =>
            StableElementObservationTransaction.CaptureAndCommit(
                new[] { candidate },
                item => [item.Identity],
                item =>
                {
                    item.Identity++;
                    return "captured";
                },
                () => new InvalidOperationException("identity changed"),
                observations =>
                {
                    commits++;
                    return observations.Count;
                }));
        Equal(0, commits, "Identity churn during capture must not reach commit.");
    }

    public static void WholeBatchIsRevalidatedBeforeOneCommit()
    {
        var first = new Candidate { Identity = 1 };
        var second = new Candidate { Identity = 2 };
        var commits = 0;
        var observations = new[] { first, second }
            .Select(item => StableElementObservationTransaction.Capture(
                item,
                candidate => [candidate.Identity],
                _ => "captured",
                () => new InvalidOperationException("identity changed")))
            .ToArray();
        second.Identity = 3;

        _ = Throws<InvalidOperationException>(() =>
            StableElementObservationTransaction.ValidateAndCommit(
                observations,
                item => [item.Identity],
                () => new InvalidOperationException("identity changed"),
                stable =>
                {
                    commits++;
                    return stable.Count;
                }));
        Equal(0, commits, "A stale member must reject the entire batch before commit.");

        second.Identity = 2;
        var count = StableElementObservationTransaction.ValidateAndCommit(
            observations,
            item => [item.Identity],
            () => new InvalidOperationException("identity changed"),
            stable =>
            {
                commits++;
                return stable.Count;
            });
        Equal(2, count, "A stable batch must reach the commit callback intact.");
        Equal(1, commits, "A stable batch must commit exactly once.");
    }

    private static TException Throws<TException>(Action action)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException exception)
        {
            return exception;
        }
        throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{message} Expected {expected}, got {actual}.");
        }
    }
}
