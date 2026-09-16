using SurfaceLoom.WindowsHost.Client;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static class AtMostOnceObserverContractTests
{
    public static void ObserverBracketsOneSubmission()
    {
        var calls = 0;
        var observer = new RecordingObserver();
        var result = UiaAtMostOnceAction.SubmitObserved(
            UiaAction.Invoke,
            observer,
            () =>
            {
                calls++;
                observer.Events.Add("submit");
                return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
            });
        Equal(1, calls, "The observed action must be submitted exactly once.");
        Equal(UiaActionSubmissionState.Returned, result.State,
            "The returned action result must cross the observer boundary unchanged.");
        True(observer.Events.SequenceEqual(["entered", "submit", "returned"]),
            "Durable observer events must bracket the one submission in exact order.");

        calls = 0;
        var enteredFailure = new RecordingObserver { FailOnEntered = true };
        _ = Throws<InvalidOperationException>(() => UiaAtMostOnceAction.SubmitObserved(
            UiaAction.Invoke,
            enteredFailure,
            () =>
            {
                calls++;
                return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
            }));
        Equal(0, calls, "A failed entered marker must prevent the external action.");

        calls = 0;
        var resultFailure = new RecordingObserver { FailOnResult = true };
        _ = Throws<InvalidOperationException>(() => UiaAtMostOnceAction.SubmitObserved(
            UiaAction.Invoke,
            resultFailure,
            () =>
            {
                calls++;
                return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
            }));
        Equal(1, calls, "A failed result marker must never cause a second submission.");
        True(resultFailure.Events.SequenceEqual(["entered", "returned"]),
            "The observer must retain entered evidence when result persistence fails.");

        var unexpected = new RecordingObserver();
        _ = Throws<ApplicationException>(() => UiaAtMostOnceAction.SubmitObserved(
            UiaAction.Invoke,
            unexpected,
            () => throw new ApplicationException("private failure")));
        True(unexpected.Events.SequenceEqual(["entered"]),
            "An unexpected submission failure must leave entered as the final evidence.");
    }

    public static void ExclusiveObserverPreventsReplay()
    {
        var sequentialSubmissions = 0;
        var sequentialObserver = new ExclusiveObserver();
        _ = UiaAtMostOnceAction.SubmitObserved(
            UiaAction.Invoke,
            sequentialObserver,
            () =>
            {
                sequentialSubmissions++;
                return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
            });
        _ = Throws<InvalidOperationException>(() => UiaAtMostOnceAction.SubmitObserved(
            UiaAction.Invoke,
            sequentialObserver,
            () =>
            {
                sequentialSubmissions++;
                return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
            }));
        Equal(1, sequentialSubmissions,
            "A consumed entered observer must prevent a sequential replay.");

        var concurrentSubmissions = 0;
        var concurrentSuccesses = 0;
        var concurrentRejections = 0;
        var concurrentObserver = new ExclusiveObserver();
        using var start = new ManualResetEventSlim(false);
        var tasks = Enumerable.Range(0, 8).Select(index => Task.Run(() =>
        {
            _ = index;
            start.Wait();
            try
            {
                _ = UiaAtMostOnceAction.SubmitObserved(
                    UiaAction.Invoke,
                    concurrentObserver,
                    () =>
                    {
                        Interlocked.Increment(ref concurrentSubmissions);
                        return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
                    });
                Interlocked.Increment(ref concurrentSuccesses);
            }
            catch (InvalidOperationException)
            {
                Interlocked.Increment(ref concurrentRejections);
            }
        })).ToArray();
        start.Set();
        Task.WaitAll(tasks);
        True(
            concurrentSubmissions == 1 &&
            concurrentSuccesses == 1 &&
            concurrentRejections == 7,
            "An exclusive observer must admit exactly one concurrent submission.");
    }

    private sealed class RecordingObserver : IUiaActionSubmissionObserver
    {
        public List<string> Events { get; } = [];
        public bool FailOnEntered { get; init; }
        public bool FailOnResult { get; init; }

        public void RecordSubmissionEntered(UiaAction action)
        {
            Equal(UiaAction.Invoke, action, "The observer received the wrong entered action.");
            Events.Add("entered");
            if (FailOnEntered) throw new InvalidOperationException("entered persistence failed");
        }

        public void RecordSubmissionResult(UiaActionSubmissionResult result)
        {
            Events.Add(result.State == UiaActionSubmissionState.Returned ? "returned" : "indeterminate");
            if (FailOnResult) throw new InvalidOperationException("result persistence failed");
        }
    }

    private sealed class ExclusiveObserver : IUiaActionSubmissionObserver
    {
        private int entered;

        public void RecordSubmissionEntered(UiaAction action)
        {
            Equal(UiaAction.Invoke, action, "The exclusive observer received the wrong action.");
            if (Interlocked.CompareExchange(ref entered, 1, 0) != 0)
            {
                throw new InvalidOperationException("The submission boundary was already consumed.");
            }
        }

        public void RecordSubmissionResult(UiaActionSubmissionResult result)
        {
            Equal(UiaAction.Invoke, result.Action, "The exclusive observer received the wrong result.");
        }
    }

    private static T Throws<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T exception) { return exception; }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static void True(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException(message);
    }
}
