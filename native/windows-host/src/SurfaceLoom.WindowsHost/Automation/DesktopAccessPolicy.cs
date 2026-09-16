using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Automation;

public static class DesktopAccessPolicy
{
    public static void ValidateDefaultInteractive(string desktop)
    {
        if (string.Equals(desktop, "default", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(desktop, "current", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        throw new HostOperationException(
            "capability_unsupported",
            "Only the current default interactive desktop is supported; UAC Secure Desktop is not automated.",
            new { capability = CapabilityCatalog.SecureDesktopFeature, requestedDesktop = desktop });
    }
}
