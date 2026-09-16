using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace SurfaceLoom.WindowsHost.Automation;

internal sealed record InputDesktopInspection(
    bool Accessible,
    string? Name,
    int? Win32Error,
    string? ErrorMessage);

internal static class InputDesktopInspector
{
    private const uint DesktopReadObjects = 0x0001;
    private const int UserObjectName = 2;

    public static InputDesktopInspection Inspect()
    {
        var desktop = OpenInputDesktop(0, false, DesktopReadObjects);
        if (desktop == IntPtr.Zero)
        {
            return FailedInspection();
        }

        try
        {
            var name = new StringBuilder(256);
            var bufferBytes = checked((uint)(name.Capacity * sizeof(char)));
            if (!GetUserObjectInformation(
                    desktop,
                    UserObjectName,
                    name,
                    bufferBytes,
                    out _))
            {
                return FailedInspection();
            }

            return new InputDesktopInspection(true, name.ToString(), null, null);
        }
        finally
        {
            _ = CloseDesktop(desktop);
        }
    }

    private static InputDesktopInspection FailedInspection()
    {
        var error = Marshal.GetLastWin32Error();
        return new InputDesktopInspection(
            false,
            null,
            error,
            new Win32Exception(error).Message);
    }

    [DllImport("user32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr OpenInputDesktop(
        uint flags,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint desiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(
        IntPtr handle,
        int index,
        StringBuilder information,
        uint length,
        out uint lengthNeeded);
}
