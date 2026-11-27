using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace SurfaceLoom.WindowsHost.Automation;

/// <summary>
/// Read-only access to process token integrity labels. It requests only
/// PROCESS_QUERY_LIMITED_INFORMATION and TOKEN_QUERY, never adjusts privileges, and never
/// elevates or duplicates a token; a denied read is reported as an unknown level.
/// </summary>
public static class WindowsIntegrityLevelReader
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const int TokenIntegrityLevelClass = 25;
    private const int ErrorBadLength = 24;
    private const int ErrorInsufficientBuffer = 122;
    private const int MaximumLabelBufferBytes = 1024;
    private const int SidHeaderBytes = 8;
    // A mandatory label SID is S-1-16-<rid>: exactly one sub-authority.
    private const byte LabelSubAuthorityCount = 1;
    // sizeof(TOKEN_MANDATORY_LABEL) = sizeof(SID_AND_ATTRIBUTES): PSID + DWORD padded to pointer
    // alignment, i.e. 8 bytes on 32-bit and 16 bytes on 64-bit. The inline SID follows it.
    private static readonly int LabelHeaderBytes = 2 * IntPtr.Size;
    private const string MandatoryLabelPrefix = "S-1-16-";

    public static WindowsIntegrityReading ReadCurrentProcess()
    {
        if (!OperatingSystem.IsWindows())
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.NotWindows);
        }

        // GetCurrentProcess returns a pseudo-handle that must not be closed; it is passed as a
        // raw IntPtr because SafeProcessHandle would treat the value -1 as invalid.
        if (!OpenProcessTokenForPseudoHandle(GetCurrentProcess(), TokenQuery, out var token))
        {
            var error = Marshal.GetLastWin32Error();
            token.Dispose();
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed, error);
        }
        using (token)
        {
            return ReadLabel(token);
        }
    }

    public static WindowsIntegrityReading ReadProcess(int processId)
    {
        if (!OperatingSystem.IsWindows())
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.NotWindows);
        }
        if (processId <= 0)
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.InvalidProcessId);
        }

        using var process = OpenProcess(
            ProcessQueryLimitedInformation,
            inheritHandle: false,
            checked((uint)processId));
        if (process.IsInvalid)
        {
            return WindowsIntegrityReading.Failed(
                WindowsIntegrityReadFailure.OpenProcessFailed,
                Marshal.GetLastWin32Error());
        }

        if (!OpenProcessToken(process, TokenQuery, out var token))
        {
            var error = Marshal.GetLastWin32Error();
            token.Dispose();
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed, error);
        }
        using (token)
        {
            return ReadLabel(token);
        }
    }

    private static WindowsIntegrityReading ReadLabel(SafeAccessTokenHandle token)
    {
        if (token.IsInvalid)
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.OpenTokenFailed);
        }

        // First call sizes the TOKEN_MANDATORY_LABEL buffer (SID_AND_ATTRIBUTES + inline SID).
        if (GetTokenInformation(token, TokenIntegrityLevelClass, IntPtr.Zero, 0, out var needed))
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }
        var sizingError = Marshal.GetLastWin32Error();
        if (sizingError is not (ErrorInsufficientBuffer or ErrorBadLength))
        {
            return WindowsIntegrityReading.Failed(
                WindowsIntegrityReadFailure.QueryTokenFailed,
                sizingError);
        }
        if (needed < LabelHeaderBytes + SidHeaderBytes + sizeof(uint) || needed > MaximumLabelBufferBytes)
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }

        var buffer = Marshal.AllocHGlobal(checked((int)needed));
        try
        {
            if (!GetTokenInformation(token, TokenIntegrityLevelClass, buffer, needed, out var written))
            {
                return WindowsIntegrityReading.Failed(
                    WindowsIntegrityReadFailure.QueryTokenFailed,
                    Marshal.GetLastWin32Error());
            }
            return ParseLabel(buffer, Math.Min(written, needed));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static WindowsIntegrityReading ParseLabel(IntPtr buffer, uint length)
    {
        if (length < LabelHeaderBytes + SidHeaderBytes + sizeof(uint))
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }
        // TOKEN_MANDATORY_LABEL.Label.Sid is the first pointer-sized field on both 32/64-bit.
        // The SID must live inside the returned bytes and after the fixed header, so every byte
        // read below stays within the buffer the kernel actually filled.
        var sid = Marshal.ReadIntPtr(buffer);
        var offset = sid.ToInt64() - buffer.ToInt64();
        if (sid == IntPtr.Zero || offset < LabelHeaderBytes || offset + SidHeaderBytes > length)
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }
        var subAuthorityCount = Marshal.ReadByte(sid, 1);
        if (subAuthorityCount != LabelSubAuthorityCount ||
            offset + SidHeaderBytes + (subAuthorityCount * sizeof(uint)) > length)
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }

        try
        {
            var value = new SecurityIdentifier(sid).Value;
            if (!value.StartsWith(MandatoryLabelPrefix, StringComparison.Ordinal))
            {
                return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
            }
            var lastSeparator = value.LastIndexOf('-');
            return uint.TryParse(
                    value.AsSpan(lastSeparator + 1),
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var rid)
                ? WindowsIntegrityReading.FromRid(rid)
                : WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }
        catch (ArgumentException)
        {
            return WindowsIntegrityReading.Failed(WindowsIntegrityReadFailure.MalformedLabel);
        }
    }

    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        SafeProcessHandle process,
        uint desiredAccess,
        out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", EntryPoint = "OpenProcessToken", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessTokenForPseudoHandle(
        IntPtr process,
        uint desiredAccess,
        out SafeAccessTokenHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        SafeAccessTokenHandle token,
        int tokenInformationClass,
        IntPtr tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);
}
