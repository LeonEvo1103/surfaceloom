using System.Runtime.InteropServices;
using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Automation;

internal static class UiaElementIdentity
{
    public static int[] ReadRuntimeId(AutomationElement element)
    {
        try
        {
            var runtimeId = element.GetRuntimeId();
            if (runtimeId is null || runtimeId.Length == 0)
            {
                throw Unavailable("The UIA provider returned an empty RuntimeId.");
            }

            return runtimeId;
        }
        catch (HostOperationException)
        {
            throw;
        }
        catch (ElementNotAvailableException exception)
        {
            throw new HostOperationException(
                "element_stale",
                "The UIA element disappeared before its identity could be read.",
                inner: exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new HostOperationException(
                "uia_access_denied",
                "The host cannot identify the UIA element across the current integrity boundary.",
                inner: exception);
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or NotSupportedException or
            COMException or InvalidComObjectException)
        {
            throw Unavailable(
                "The UIA provider could not supply a stable RuntimeId.",
                exception);
        }
    }

    private static HostOperationException Unavailable(
        string message,
        Exception? inner = null) =>
        new(
            "element_identity_unavailable",
            $"{message} The host will not create an unbounded fallback handle.",
            inner: inner);
}
