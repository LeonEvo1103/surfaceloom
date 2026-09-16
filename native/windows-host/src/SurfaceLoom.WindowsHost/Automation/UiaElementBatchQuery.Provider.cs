using System.Runtime.InteropServices;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

internal static partial class UiaElementBatchQuery
{
    private static IReadOnlyList<AutomationElement> QueryOnce(
        AutomationElement root,
        IReadOnlyList<UiaLocator> clauses,
        int? restrictToProcessId)
    {
        var clauseConditions = clauses
            .Select(UiaLocatorCompiler.Compile)
            .ToArray();
        Condition condition = clauseConditions.Length == 1
            ? clauseConditions[0]
            : new OrCondition(clauseConditions);
        if (restrictToProcessId is int processId)
        {
            condition = new AndCondition(
                new PropertyCondition(AutomationElement.ProcessIdProperty, processId),
                condition);
        }

        try
        {
            // Scope is deliberately widened only for this one provider traversal. Each original
            // clause's scope is reapplied during classification; selector groups are never merged.
            var collection = root.FindAll(TreeScope.Subtree, condition);
            ValidateUniqueElementCount(collection.Count);
            var elements = new AutomationElement[collection.Count];
            for (var index = 0; index < collection.Count; index++)
            {
                elements[index] = collection[index];
            }
            return elements;
        }
        catch (ElementNotAvailableException exception)
        {
            throw new HostOperationException(
                "root_stale",
                "The selected batch search root is no longer available; locate its owning surface again.",
                inner: exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new HostOperationException(
                "uia_access_denied",
                "The host cannot query the UIA tree across the current integrity boundary.",
                inner: exception);
        }
        catch (HostOperationException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or COMException or InvalidComObjectException)
        {
            throw new HostOperationException(
                "uia_query_failed",
                "The UIA provider failed while executing the shared batch tree query.",
                new { exceptionType = exception.GetType().Name },
                exception);
        }
    }

    private static UiaBatchElementRelation ReadDescendantRelation(
        int[] rootRuntimeId,
        AutomationElement candidate)
    {
        try
        {
            var parent = TreeWalker.RawViewWalker.GetParent(candidate);
            if (parent is null)
            {
                throw new HostOperationException(
                    "uia_batch_scope_unavailable",
                    "The UIA provider did not expose a parent for an element returned below the batch root.");
            }

            var parentRuntimeId = UiaElementIdentity.ReadRuntimeId(parent);
            return RuntimeIdComparer.Instance.Equals(parentRuntimeId, rootRuntimeId)
                ? UiaBatchElementRelation.DirectChild
                : UiaBatchElementRelation.DeeperDescendant;
        }
        catch (HostOperationException)
        {
            throw;
        }
        catch (ElementNotAvailableException exception)
        {
            throw new HostOperationException(
                "uia_batch_scope_unavailable",
                "The UIA hierarchy changed before the batch scope could be classified.",
                inner: exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new HostOperationException(
                "uia_access_denied",
                "The host cannot read the UIA hierarchy across the current integrity boundary.",
                inner: exception);
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or COMException or InvalidComObjectException)
        {
            throw new HostOperationException(
                "uia_batch_scope_unavailable",
                "The UIA provider failed while classifying batch search scope.",
                new { exceptionType = exception.GetType().Name },
                exception);
        }
    }

    private static Exception ObservationChanged() => new HostOperationException(
        "uia_batch_observation_changed",
        "The UIA tree changed while the complete batch observation was captured; no handles were published.");

    private sealed class RuntimeIdComparer : IEqualityComparer<int[]>
    {
        public static RuntimeIdComparer Instance { get; } = new();

        public bool Equals(int[]? left, int[]? right) =>
            ReferenceEquals(left, right) ||
            left is not null && right is not null && left.AsSpan().SequenceEqual(right);

        public int GetHashCode(int[] value)
        {
            var hash = new HashCode();
            foreach (var part in value)
            {
                hash.Add(part);
            }
            return hash.ToHashCode();
        }
    }
}
