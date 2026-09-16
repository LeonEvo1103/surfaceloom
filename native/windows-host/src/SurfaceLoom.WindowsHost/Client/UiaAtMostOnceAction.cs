using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Client;

public enum UiaActionSubmissionState
{
    Returned,
    Indeterminate,
}

/// <summary>
/// Records whether a UIA action returned normally or may have completed before the provider
/// failed to return its post-action snapshot. Construction prevents contradictory states.
/// </summary>
public sealed record UiaActionSubmissionResult
{
    private UiaActionSubmissionResult(
        UiaAction action,
        UiaActionSubmissionState state,
        string? failureCode,
        Exception? failure)
    {
        Action = action;
        State = state;
        FailureCode = failureCode;
        Failure = failure;
    }

    public UiaAction Action { get; }
    public UiaActionSubmissionState State { get; }
    public string? FailureCode { get; }
    public Exception? Failure { get; }

    public static UiaActionSubmissionResult Returned(UiaAction action) =>
        new(action, UiaActionSubmissionState.Returned, null, null);

    public static UiaActionSubmissionResult Indeterminate(
        UiaAction action,
        string failureCode,
        Exception failure)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(failureCode);
        ArgumentNullException.ThrowIfNull(failure);
        return new(action, UiaActionSubmissionState.Indeterminate, failureCode, failure);
    }
}

/// <summary>
/// Receives durable, non-retrying evidence immediately around one external UIA action.
/// An observer failure before submission prevents the action; a failure after submission
/// propagates while the caller still treats the action as consumed.
/// </summary>
public interface IUiaActionSubmissionObserver
{
    void RecordSubmissionEntered(UiaAction action);
    void RecordSubmissionResult(UiaActionSubmissionResult result);
}

public static class UiaAtMostOnceAction
{
    public static UiaActionSubmissionResult SubmitObserved(
        UiaAction action,
        IUiaActionSubmissionObserver? observer,
        Func<UiaActionSubmissionResult> submitOnce)
    {
        ArgumentNullException.ThrowIfNull(submitOnce);
        observer?.RecordSubmissionEntered(action);
        var result = submitOnce() ??
            throw new InvalidOperationException("The one-shot UIA submission returned no result.");
        if (result.Action != action)
        {
            throw new InvalidOperationException(
                "The one-shot UIA result identified a different action than the submission boundary.");
        }
        observer?.RecordSubmissionResult(result);
        return result;
    }

    public static T RequirePostcondition<T>(
        string operationKey,
        Func<UiaActionSubmissionResult> submitOnce,
        Func<T> requirePostcondition)
    {
        RequireSafeOperationKey(operationKey);
        ArgumentNullException.ThrowIfNull(submitOnce);
        ArgumentNullException.ThrowIfNull(requirePostcondition);

        var submission = submitOnce();
        try
        {
            return requirePostcondition();
        }
        catch (Exception postconditionFailure)
        {
            var actionStatus = submission.State == UiaActionSubmissionState.Returned
                ? "the at-most-once UIA action returned"
                : $"the at-most-once UIA action became indeterminate ({SafeCode(submission.FailureCode)})";
            var inner = submission.Failure is null
                ? postconditionFailure
                : new AggregateException(submission.Failure, postconditionFailure);
            throw new UiaPostconditionException(
                $"{operationKey}: {actionStatus}, but its required postcondition was not reached.",
                inner);
        }
    }

    internal static string RequireSafeOperationKey(string operationKey)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(operationKey);
        if (!operationKey.All(character =>
                char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-'))
        {
            throw new ArgumentException(
                "The operation key must be a non-sensitive machine identifier.",
                nameof(operationKey));
        }
        return operationKey;
    }

    private static string SafeCode(string? code) =>
        !string.IsNullOrWhiteSpace(code) && code.All(character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-')
                ? code
                : "uia_failure";
}

public sealed class UiaPostconditionException(string message, Exception innerException)
    : Exception(message, innerException);
