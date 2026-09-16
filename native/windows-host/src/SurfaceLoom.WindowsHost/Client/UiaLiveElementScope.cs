using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Client;

/// <summary>
/// Re-resolves a semantic owner before each scoped operation. UIA element handles are snapshots;
/// this prevents a dialog or pane remount from turning a long-lived scoped root stale.
/// </summary>
public sealed class UiaLiveElementScope
{
    private readonly Func<ElementSnapshot> resolveOwner;

    public UiaLiveElementScope(Func<ElementSnapshot> resolveOwner)
    {
        ArgumentNullException.ThrowIfNull(resolveOwner);
        this.resolveOwner = resolveOwner;
    }

    public ElementSnapshot Resolve()
    {
        var owner = resolveOwner();
        if (owner is null || string.IsNullOrWhiteSpace(owner.ElementId))
        {
            throw new InvalidOperationException(
                "A live UIA scope resolver returned an owner without a stable element handle.");
        }
        return owner;
    }
}
