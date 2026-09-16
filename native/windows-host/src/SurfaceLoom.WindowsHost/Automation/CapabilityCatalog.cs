using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Automation;

public static class CapabilityCatalog
{
    public const string SecureDesktopFeature = "windows.uac.secureDesktop";

    public static HostCapabilities Create() => new(
        ProtocolVersion: HostProtocol.Version,
        Platform: "windows",
        Backend: "windows-ui-automation",
        Methods: HostProtocol.Methods,
        LocatorFields:
        [
            "automationIds",
            "names",
            "controlTypes",
            "classNames",
            "frameworkIds",
            "nativeWindowHandle",
        ],
        ControlTypes: UiaControlTypeMap.Names,
        ActionRequirements: UiaActionExecutor.PatternRequirements,
        Features: new Dictionary<string, CapabilityStatus>(StringComparer.Ordinal)
        {
            ["host.doctor"] = Supported(
                "Reports Windows, session, interactive desktop, UIA, and security boundaries without mutating host or app state."),
            ["uia.locator"] = Supported(
                "Locates accessible elements by AutomationId, Name, ControlType, ClassName, FrameworkId, or HWND."),
            ["uia.findAll"] = Supported(
                "Returns every element matching one strict locator, or an empty array after its wait timeout."),
            ["uia.batchQuery"] = Supported(
                $"Classifies one immediate UIA tree observation against up to {ElementBatchQueryLimits.MaxClauses} complete locators without flattening their AND constraints; output is bounded to {ElementBatchQueryLimits.MaxUniqueElements} unique and {ElementBatchQueryLimits.MaxReturnedElements} clause-returned elements."),
            ["uia.elementScopedFind"] = Supported(
                "Constrains find and findAll to a remembered element in the same session."),
            ["uia.stableElementHandles"] = Supported(
                "Reuses handles by UIA RuntimeId and fails closed at 4096 distinct elements per session."),
            ["uia.elementState"] = Supported(
                "Snapshots readable value, focus, selection, toggle, expand/collapse, ARIA, and read-only state."),
            ["uia.semanticActions"] = Supported(
                "Uses UIA patterns for invoke, value, toggle, selection, expand/collapse, and focus; every action revalidates RuntimeId, process, the complete locator, current state, and its required pattern immediately before execution."),
            ["uia.checkedActionTarget"] = Supported(
                "Binds each action to the remembered RuntimeId plus an explicit process, root handle, and complete locator including scope in the same host dispatch."),
            ["application.attach"] = Supported(
                "Attaches only by explicit process id; attached processes are never terminated by the host."),
            ["application.launch"] = Supported(
                "Launches one explicit absolute executable path without shell expansion and owns the returned process."),
            ["application.rejectExisting"] = Supported(
                "Launch refuses a same-name running target instead of taking over an existing app instance."),
            ["application.gracefulClose"] = Conditional(
                "Requests WM_CLOSE through Process.CloseMainWindow only for a host-owned process.",
                "Tray apps and multi-window apps may require an app-specific semantic quit action."),
            ["application.terminateOwned"] = Supported(
                "Terminates only a process created and owned by this host, including its child process tree."),
            ["input.pointerInjection"] = Unsupported(
                "No coordinate or synthetic pointer fallback is performed."),
            ["input.keyboardInjection"] = Unsupported(
                "Keyboard injection is not part of the UIA semantic action backend."),
            ["system.fileDialog"] = Conditional(
                "Common file dialogs can be traversed when visible in the current UIA desktop.",
                "No dedicated file-dialog component is included yet."),
            ["system.desktopRoot"] = Supported(
                "Creates an explicit system session rooted at the current default interactive desktop."),
            ["windows.elevatedTarget"] = Conditional(
                "UIA access depends on Windows integrity and UIAccess boundaries.",
                "Run the host at an integrity level permitted to inspect the target."),
            [SecureDesktopFeature] = Unsupported(
                "UAC Secure Desktop is a separate security desktop and will not be bypassed or auto-approved."),
            ["session.parallel"] = Unsupported(
                "The host serializes requests on one STA thread; use one host process per isolated test session."),
            ["vision.imageMatching"] = Unsupported(
                "This backend intentionally exposes deterministic UIA state only."),
        });

    private static CapabilityStatus Supported(string summary) =>
        new(SupportLevel.Supported, summary);

    private static CapabilityStatus Unsupported(string summary) =>
        new(SupportLevel.Unsupported, summary);

    private static CapabilityStatus Conditional(string summary, params string[] conditions) =>
        new(SupportLevel.Conditional, summary, conditions);
}
