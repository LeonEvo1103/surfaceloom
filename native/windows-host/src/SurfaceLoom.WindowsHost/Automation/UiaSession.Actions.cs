using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public sealed partial class UiaSession
{
    /// <summary>
    /// Revalidates and performs one semantic action against the same AutomationElement in the
    /// same host dispatch. No RPC, client query, or handle re-resolution occurs between the
    /// checked target proof and the UIA pattern call.
    /// </summary>
    public ElementSnapshot PerformCheckedAction(ElementActionRequest request)
    {
        ThrowIfDisposed();
        ProtocolValidator.Validate(request);
        if (!elements.TryResolve(
                request.ElementId,
                out var element,
                out var rememberedRuntimeId))
        {
            throw UnknownElement(request.ElementId);
        }

        var expected = request.ExpectedTarget!;
        var (searchRoot, rememberedRootRuntimeId) =
            ResolveCheckedActionRoot(expected.RootElementId);
        var candidates = UiaElementFinder.FindAll(
            searchRoot,
            expected.Locator,
            new WaitOptions { TimeoutMs = 0, PollIntervalMs = 10 },
            RestrictedProcessId);
        if (!rememberedRootRuntimeId.SequenceEqual(UiaElementIdentity.ReadRuntimeId(searchRoot)))
        {
            throw UiaActionTargetGuard.ChangedTarget(
                "The checked action search root changed during scope validation.");
        }
        AutomationElement? checkedElement = null;
        foreach (var candidate in candidates)
        {
            if (!rememberedRuntimeId!.SequenceEqual(UiaElementIdentity.ReadRuntimeId(candidate)))
            {
                continue;
            }
            if (checkedElement is not null)
            {
                throw UiaActionTargetGuard.ChangedTarget(
                    "The checked action scope returned the remembered RuntimeId more than once.");
            }
            checkedElement = candidate;
        }
        if (checkedElement is null)
        {
            throw UiaActionTargetGuard.ChangedTarget(
                "The remembered action target no longer matches its locator and root scope.");
        }

        var beforeSnapshotRuntimeId = UiaElementIdentity.ReadRuntimeId(checkedElement);
        var current = UiaElementSnapshotter.Create(request.ElementId, checkedElement);
        var afterSnapshotRuntimeId = UiaElementIdentity.ReadRuntimeId(checkedElement);
        UiaActionTargetGuard.SubmitIfCurrent(
            request,
            current,
            rememberedRuntimeId!,
            beforeSnapshotRuntimeId,
            afterSnapshotRuntimeId,
            () => UiaActionExecutor.Perform(checkedElement, request));
        var postAction = StableElementObservationTransaction.Capture(
            checkedElement,
            UiaElementIdentity.ReadRuntimeId,
            candidate => UiaElementSnapshotter.Create(request.ElementId, candidate),
            () => UiaActionTargetGuard.ChangedTarget(
                "The checked action target changed while its post-action state was captured."));
        if (!rememberedRuntimeId!.SequenceEqual(postAction.RuntimeId))
        {
            throw UiaActionTargetGuard.ChangedTarget(
                "The checked action target changed before its post-action state was returned.");
        }
        return postAction.Snapshot;
    }

    private (AutomationElement Element, IReadOnlyList<int> RuntimeId)
        ResolveCheckedActionRoot(string rootElementId)
    {
        if (!elements.TryResolve(rootElementId, out var root, out var rememberedRuntimeId))
        {
            throw UnknownElement(rootElementId);
        }
        var currentRuntimeId = UiaElementIdentity.ReadRuntimeId(root!);
        if (!rememberedRuntimeId!.SequenceEqual(currentRuntimeId))
        {
            throw UiaActionTargetGuard.ChangedTarget(
                "The checked action search root changed identity.");
        }
        return (root!, rememberedRuntimeId!);
    }
}
