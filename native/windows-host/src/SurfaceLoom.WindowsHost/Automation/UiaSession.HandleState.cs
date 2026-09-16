using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public sealed partial class UiaSession
{
    public ElementSnapshot RememberRoot() => Remember(Root);

    public AutomationElement Resolve(string elementId)
    {
        ThrowIfDisposed();
        var remembered = ResolveRemembered(elementId);
        RequireCurrentIdentity(remembered);
        return remembered.Element;
    }

    public ElementSnapshot Snapshot(string elementId)
    {
        ThrowIfDisposed();
        var remembered = ResolveRemembered(elementId);
        var observation = StableElementObservationTransaction.Capture(
            remembered.Element,
            UiaElementIdentity.ReadRuntimeId,
            candidate => UiaElementSnapshotter.Create(elementId, candidate),
            ObservationChanged);
        if (!remembered.RuntimeId.SequenceEqual(observation.RuntimeId))
        {
            throw ObservationChanged();
        }
        return observation.Snapshot;
    }

    public ElementSnapshot Remember(AutomationElement element)
        => Remember(element, beforeCommit: () => { });

    private ElementSnapshot Remember(AutomationElement element, Action beforeCommit)
    {
        return StableElementObservationTransaction.CaptureAndCommit(
            new[] { element },
            UiaElementIdentity.ReadRuntimeId,
            candidate => UiaElementSnapshotter.Create("unregistered", candidate),
            ObservationChanged,
            observations =>
            {
                beforeCommit();
                return CommitOne(observations[0]);
            });
    }

    private ElementSnapshot CommitOne(
        StableElementObservation<AutomationElement, ElementSnapshot> observation)
    {
        if (!elements.TryRemember(
                observation.RuntimeId,
                observation.Element,
                out var elementId))
        {
            throw new HostOperationException(
                "element_handle_limit",
                $"The session reached its limit of {ElementHandleLimit} remembered UIA elements.",
                new { limit = ElementHandleLimit });
        }
        return observation.Snapshot with { ElementId = elementId };
    }

    private static Exception ObservationChanged() => new HostOperationException(
        "uia_element_observation_changed",
        "The UIA element changed identity while its complete snapshot was captured; no handle was published.");

    private RememberedElement ResolveSearchRoot(string? rootElementId)
    {
        var remembered = rootElementId is null
            ? new RememberedElement(Root, rootRuntimeId)
            : ResolveRemembered(rootElementId);
        RequireCurrentIdentity(remembered);
        return remembered;
    }

    private RememberedElement ResolveRemembered(string elementId)
    {
        if (!elements.TryResolve(elementId, out var element, out var runtimeId))
        {
            throw UnknownElement(elementId);
        }
        return new RememberedElement(element!, runtimeId!.ToArray());
    }

    private static void RequireCurrentIdentity(RememberedElement remembered)
    {
        if (!remembered.RuntimeId.SequenceEqual(
                UiaElementIdentity.ReadRuntimeId(remembered.Element)))
        {
            throw ObservationChanged();
        }
    }

    private sealed record RememberedElement(AutomationElement Element, int[] RuntimeId);

    private HostOperationException UnknownElement(string elementId) =>
        new(
            "element_handle_unknown",
            $"Element handle '{elementId}' does not belong to session '{Id}'.");
}
