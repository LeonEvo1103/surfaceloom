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
    private static string Sha256Prefix(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..16];

    private static WaitOptions ZeroWait() => new() { TimeoutMs = 0, PollIntervalMs = 10 };

    private static ElementSnapshot Snapshot(
        string? value = null,
        bool hasKeyboardFocus = false,
        bool? isSelected = null,
        string? toggleState = null,
        string? expandCollapseState = null,
        string? ariaRole = null,
        string? ariaProperties = null,
        bool? isReadOnly = null) =>
        new(
            "element", "Name", "automation.id", "button", "Class", "Framework",
            123, 456, true, false, value, hasKeyboardFocus, isSelected, toggleState,
            expandCollapseState, ariaRole, ariaProperties, isReadOnly, [UiaAction.Invoke]);

    private static ElementSnapshot Candidate(
        string elementId,
        bool isEnabled = true,
        bool isOffscreen = false,
        bool? isReadOnly = null,
        bool? isSelected = null,
        string? toggleState = null,
        string? expandCollapseState = null,
        string? ariaRole = null,
        IReadOnlyList<UiaAction>? actions = null) =>
        new(
            elementId, "candidate", string.Empty, "button", string.Empty, "Chrome",
            123, 0, isEnabled, isOffscreen, null, false, isSelected, toggleState,
            expandCollapseState, ariaRole, null, isReadOnly, actions ?? [UiaAction.Invoke]);

    private static ElementSnapshot BatchSnapshot(
        string elementId,
        string name,
        string automationId,
        string controlType = "button",
        string className = "Class",
        string frameworkId = "Framework",
        int nativeWindowHandle = 0) =>
        new(
            elementId, name, automationId, controlType, className, frameworkId,
            123, nativeWindowHandle, true, false, null, false, null, null,
            null, null, null, null, [UiaAction.Invoke]);

    private static T Throws<T>(Action action)
        where T : Exception
    {
        try
        {
            action();
        }
        catch (T exception)
        {
            return exception;
        }

        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static void True(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{message} Expected: {expected}; actual: {actual}.");
        }
    }
}
