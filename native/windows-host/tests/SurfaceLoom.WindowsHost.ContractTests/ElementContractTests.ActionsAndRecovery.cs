using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Client;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static partial class ElementContractTests
{
    public static void DisclosureActionsRequireProvenState()
    {
        var collapsed = Candidate(
            "collapsed",
            expandCollapseState: "collapsed",
            actions: [UiaAction.Expand, UiaAction.Invoke]);
        True(UiaDisclosureActionPlanner.IsProvenClosed(collapsed),
            "Collapsed must be the only proven closed state.");
        True(UiaDisclosureActionPlanner.TryPlanOpen(collapsed, out var open) &&
             open == UiaAction.Expand,
            "Expand must be preferred over Invoke when opening a collapsed disclosure.");

        var invokeOnlyClosed = Candidate(
            "invoke-closed",
            expandCollapseState: "collapsed",
            actions: [UiaAction.Invoke]);
        True(!UiaDisclosureActionPlanner.TryPlanOpen(invokeOnlyClosed, out _),
            "Invoke-only disclosures must fail closed instead of guessing a toggle.");

        var expanded = Candidate(
            "expanded",
            expandCollapseState: "expanded",
            actions: [UiaAction.Collapse, UiaAction.Invoke]);
        True(UiaDisclosureActionPlanner.IsProvenOpen(expanded),
            "Expanded must be a proven open state.");
        True(UiaDisclosureActionPlanner.TryPlanClose(expanded, out var close) &&
             close == UiaAction.Collapse,
            "Collapse must be preferred over Invoke when closing an expanded disclosure.");

        var partiallyExpanded = Candidate(
            "partial",
            expandCollapseState: "partiallyExpanded",
            actions: [UiaAction.Collapse, UiaAction.Invoke]);
        True(UiaDisclosureActionPlanner.IsProvenOpen(partiallyExpanded),
            "Partially expanded is safely closeable, not safely openable.");
        True(UiaDisclosureActionPlanner.TryPlanClose(partiallyExpanded, out close) &&
             close == UiaAction.Collapse,
            "Collapse may safely close a partially expanded disclosure.");
        True(!UiaDisclosureActionPlanner.TryPlanOpen(partiallyExpanded, out _),
            "Partially expanded must not be treated as closed.");

        True(!UiaDisclosureActionPlanner.TryPlanClose(
                Candidate("invoke-open", expandCollapseState: "expanded",
                    actions: [UiaAction.Invoke]), out _),
            "Invoke-only open disclosures must also fail closed.");

        foreach (var state in new string?[] { null, "leafNode", "future-state" })
        {
            var unknown = Candidate(
                $"state-{state ?? "null"}",
                expandCollapseState: state,
                actions: [UiaAction.Expand, UiaAction.Collapse, UiaAction.Invoke]);
            True(!UiaDisclosureActionPlanner.IsProvenClosed(unknown) &&
                 !UiaDisclosureActionPlanner.IsProvenOpen(unknown),
                "Null, leaf, and unknown states must not imply a disclosure state.");
            True(!UiaDisclosureActionPlanner.TryPlanOpen(unknown, out _) &&
                 !UiaDisclosureActionPlanner.TryPlanClose(unknown, out _),
                "Null, leaf, and unknown states must fail closed for both transitions.");
        }

        True(!UiaDisclosureActionPlanner.TryPlanOpen(
                Candidate("wrong-open-action", expandCollapseState: "collapsed",
                    actions: [UiaAction.Collapse]), out _),
            "An unrelated supported action must not be guessed for open.");
        True(!UiaDisclosureActionPlanner.TryPlanClose(
                Candidate("wrong-close-action", expandCollapseState: "expanded",
                    actions: [UiaAction.Expand]), out _),
            "An unrelated supported action must not be guessed for close.");
    }

    public static void AtMostOnceActionsUsePostconditions()
    {
        var submissions = 0;
        var returned = UiaActionSubmissionResult.Returned(UiaAction.Invoke);
        Equal(UiaActionSubmissionState.Returned, returned.State,
            "Returned factory must create an internally consistent result.");
        True(returned.Failure is null && returned.FailureCode is null,
            "A returned action must not carry failure metadata.");

        var returnedResult = UiaAtMostOnceAction.RequirePostcondition(
            "disclosure.open",
            () =>
            {
                submissions++;
                return returned;
            },
            () => "open");
        Equal("open", returnedResult, "A returned action still requires its postcondition.");
        Equal(1, submissions, "A returned action must be submitted exactly once.");

        var actionFailure = new InvalidOperationException("private action failure");
        var indeterminate = UiaActionSubmissionResult.Indeterminate(
            UiaAction.Invoke,
            "element_stale",
            actionFailure);
        Equal(UiaActionSubmissionState.Indeterminate, indeterminate.State,
            "Indeterminate factory must retain the uncertain action state.");
        submissions = 0;
        var indeterminateResult = UiaAtMostOnceAction.RequirePostcondition(
            "disclosure.open",
            () =>
            {
                submissions++;
                return indeterminate;
            },
            () => "postcondition-proven");
        Equal("postcondition-proven", indeterminateResult,
            "A proven postcondition decides success after an indeterminate response.");
        Equal(1, submissions, "An indeterminate action must never be retried.");

        submissions = 0;
        var returnedPostFailure = new InvalidOperationException("private returned postcondition");
        var returnedFailure = Throws<UiaPostconditionException>(() =>
            UiaAtMostOnceAction.RequirePostcondition<object>(
            "disclosure.close",
            () =>
            {
                submissions++;
                return UiaActionSubmissionResult.Returned(UiaAction.Invoke);
            },
            () => throw returnedPostFailure));
        Equal(1, submissions, "A failed returned action postcondition must not retry.");
        True(ReferenceEquals(returnedFailure.InnerException, returnedPostFailure),
            "A returned action has exactly the postcondition failure as its cause.");
        True(!returnedFailure.Message.Contains("private", StringComparison.Ordinal),
            "The outer at-most-once error must not disclose arbitrary failure messages.");

        submissions = 0;
        var indeterminatePostFailure = new InvalidOperationException("private indeterminate postcondition");
        var indeterminateFailure = Throws<UiaPostconditionException>(() =>
            UiaAtMostOnceAction.RequirePostcondition<object>(
                "disclosure.close",
                () =>
                {
                    submissions++;
                    return indeterminate;
                },
                () => throw indeterminatePostFailure));
        Equal(1, submissions, "Two failures must still submit the action exactly once.");
        var aggregate = indeterminateFailure.InnerException as AggregateException;
        True(aggregate is not null && aggregate.InnerExceptions.Count == 2,
            "Indeterminate action and postcondition failures must both be retained.");
        True(ReferenceEquals(aggregate!.InnerExceptions[0], actionFailure) &&
             ReferenceEquals(aggregate.InnerExceptions[1], indeterminatePostFailure),
            "The aggregate must retain both original failures without replacing them.");

        _ = Throws<ArgumentException>(() => UiaActionSubmissionResult.Indeterminate(
            UiaAction.Invoke, " ", actionFailure));
        _ = Throws<ArgumentNullException>(() => UiaActionSubmissionResult.Indeterminate(
            UiaAction.Invoke, "element_stale", null!));
    }

    public static void UiStateRecoveryAndTaintBarrierAreFailClosed()
    {
        var bodyCalls = 0;
        var recoveryCalls = 0;
        UiStateRecovery.Run(
            "dialog.roundtrip",
            () => bodyCalls++,
            () => recoveryCalls++);
        Equal(1, bodyCalls, "A successful reversible operation must run once.");
        Equal(0, recoveryCalls, "Successful operations must not run failure recovery.");

        var original = new InvalidOperationException("private original failure");
        var recovered = Throws<InvalidOperationException>(() => UiStateRecovery.Run(
            "dialog.roundtrip",
            () => throw original,
            () => recoveryCalls++));
        True(ReferenceEquals(original, recovered),
            "Successful recovery must rethrow the original operation failure unchanged.");
        Equal(1, recoveryCalls, "A failed operation must attempt recovery exactly once.");

        var cleanup = new InvalidOperationException("private cleanup failure");
        var tainted = Throws<UiStateTaintedException>(() => UiStateRecovery.Run(
            "dialog.roundtrip",
            () => throw original,
            () => throw cleanup));
        Equal("dialog.roundtrip", tainted.OperationKey,
            "Taint evidence must retain the non-sensitive operation key.");
        True(ReferenceEquals(tainted.InnerException, original) &&
             ReferenceEquals(tainted.CleanupFailure, cleanup),
            "Taint evidence must retain both original and cleanup failures.");
        True(!tainted.Message.Contains("private", StringComparison.Ordinal),
            "Taint summaries must not disclose arbitrary failure messages.");

        UiStateRecovery.RequireRestoredOrRethrow(
            "dialog.lifecycle",
            originalFailure: null,
            cleanupFailure: null);
        var originalOnly = Throws<InvalidOperationException>(() =>
            UiStateRecovery.RequireRestoredOrRethrow(
                "dialog.lifecycle",
                original,
                cleanupFailure: null));
        True(ReferenceEquals(originalOnly, original),
            "A successful lifecycle cleanup must preserve the original failure unchanged.");
        var cleanupOnly = Throws<UiStateTaintedException>(() =>
            UiStateRecovery.RequireRestoredOrRethrow(
                "dialog.lifecycle",
                originalFailure: null,
                cleanupFailure: cleanup));
        True(ReferenceEquals(cleanupOnly.CleanupFailure, cleanup),
            "A cleanup-only lifecycle failure must taint instead of permitting later work.");
        True(!cleanupOnly.Message.Contains("private", StringComparison.Ordinal) &&
             !cleanupOnly.InnerException!.Message.Contains("private", StringComparison.Ordinal),
            "A cleanup-only taint must synthesize only a bounded non-sensitive original cause.");

        var barrier = new UiStateTaintBarrier();
        True(barrier.CanBeginOperation && barrier.Cause is null,
            "A fresh barrier permits live operations.");
        barrier.Trip(tainted);
        True(!barrier.CanBeginOperation && ReferenceEquals(barrier.Cause, tainted),
            "The first taint must stop subsequent operations.");
        var laterTaint = new UiStateTaintedException(
            "dialog.second", new Exception("later"), new Exception("later cleanup"));
        barrier.Trip(laterTaint);
        True(ReferenceEquals(barrier.Cause, tainted),
            "A barrier must preserve the first causal taint.");
        _ = Throws<ArgumentNullException>(() => barrier.Trip(null!));
    }
}
