using System.Runtime.ExceptionServices;

namespace SurfaceLoom.WindowsHost.Client;

public sealed class UiStateTaintedException : Exception
{
    public UiStateTaintedException(
        string operationKey,
        Exception originalFailure,
        Exception cleanupFailure)
        : base(
            $"{UiaAtMostOnceAction.RequireSafeOperationKey(operationKey)}: cleanup could not " +
            "prove that the UI baseline was restored.",
            RequireFailure(originalFailure, nameof(originalFailure)))
    {
        ArgumentNullException.ThrowIfNull(cleanupFailure);
        OperationKey = operationKey;
        CleanupFailure = cleanupFailure;
    }

    public string OperationKey { get; }
    public Exception CleanupFailure { get; }

    private static Exception RequireFailure(Exception failure, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(failure, parameterName);
        return failure;
    }
}

/// <summary>
/// Runs recovery after any failed reversible UI operation. A recovery failure taints the
/// process-wide UI state and must stop later live cases from starting.
/// </summary>
public static class UiStateRecovery
{
    public static void Run(string operationKey, Action body, Action recover)
    {
        UiaAtMostOnceAction.RequireSafeOperationKey(operationKey);
        ArgumentNullException.ThrowIfNull(body);
        ArgumentNullException.ThrowIfNull(recover);

        try
        {
            body();
        }
        catch (Exception originalFailure)
        {
            try
            {
                recover();
            }
            catch (Exception cleanupFailure)
            {
                throw new UiStateTaintedException(
                    operationKey,
                    originalFailure,
                    cleanupFailure);
            }
            throw;
        }
    }

    /// <summary>
    /// Completes an explicit try/finally lifecycle without allowing cleanup to replace the
    /// original failure or a cleanup-only failure to pass as an ordinary case failure.
    /// </summary>
    public static void RequireRestoredOrRethrow(
        string operationKey,
        Exception? originalFailure,
        Exception? cleanupFailure)
    {
        var safeOperationKey = UiaAtMostOnceAction.RequireSafeOperationKey(operationKey);
        if (cleanupFailure is not null)
        {
            throw new UiStateTaintedException(
                safeOperationKey,
                originalFailure ?? new InvalidOperationException(
                    $"{safeOperationKey}: the operation completed before cleanup failed."),
                cleanupFailure);
        }
        if (originalFailure is not null)
        {
            ExceptionDispatchInfo.Capture(originalFailure).Throw();
        }
    }
}

/// <summary>
/// A reusable runner barrier: once recovery cannot prove a baseline, no subsequent UI case
/// may begin in the same process/lease.
/// </summary>
public sealed class UiStateTaintBarrier
{
    public bool CanBeginOperation => Cause is null;
    public UiStateTaintedException? Cause { get; private set; }

    public void Trip(UiStateTaintedException cause)
    {
        ArgumentNullException.ThrowIfNull(cause);
        Cause ??= cause;
    }
}
