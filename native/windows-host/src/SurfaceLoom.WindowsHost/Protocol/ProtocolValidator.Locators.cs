namespace SurfaceLoom.WindowsHost.Protocol;

public static partial class ProtocolValidator
{
    public static void Validate(UiaLocator locator, bool allowEmpty)
    {
        if (locator.AutomationIds is null ||
            locator.Names is null ||
            locator.ControlTypes is null ||
            locator.ClassNames is null ||
            locator.FrameworkIds is null)
        {
            throw Invalid("locator selector arrays must not be null.");
        }

        if (!allowEmpty && !HasSelector(locator))
        {
            throw Invalid("locator must contain at least one stable selector.");
        }

        if (locator.MatchIndex < 0)
        {
            throw Invalid("matchIndex must not be negative.");
        }

        if (!Enum.IsDefined(locator.Scope))
        {
            throw Invalid("scope must be a declared element search scope.");
        }

        ValidateStrings(locator.AutomationIds, "automationIds");
        ValidateStrings(locator.Names, "names");
        ValidateStrings(locator.ControlTypes, "controlTypes");
        ValidateStrings(locator.ClassNames, "classNames");
        ValidateStrings(locator.FrameworkIds, "frameworkIds");
    }

    public static void Validate(WaitOptions wait)
    {
        if (wait.TimeoutMs is < 0 or > 120_000)
        {
            throw Invalid("timeoutMs must be between 0 and 120000.");
        }

        if (wait.PollIntervalMs is < 10 or > 5_000)
        {
            throw Invalid("pollIntervalMs must be between 10 and 5000.");
        }
    }

    private static bool HasSelector(UiaLocator locator) =>
        locator.AutomationIds.Count > 0 ||
        locator.Names.Count > 0 ||
        locator.ControlTypes.Count > 0 ||
        locator.ClassNames.Count > 0 ||
        locator.FrameworkIds.Count > 0 ||
        locator.NativeWindowHandle.HasValue;

    private static void ValidateStrings(IReadOnlyList<string> values, string property)
    {
        if (values.Any(string.IsNullOrWhiteSpace))
        {
            throw Invalid($"{property} must not contain empty values.");
        }
    }
}
