using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Protocol;

public static partial class ProtocolValidator
{
    public static void Validate(FindElementRequest request)
    {
        RequireIdentifier(request.SessionId, "sessionId");
        if (request.RootElementId is not null)
        {
            RequireIdentifier(request.RootElementId, "rootElementId");
        }

        if (request.Locator is null || request.Wait is null)
        {
            throw Invalid("locator and wait must not be null.");
        }

        Validate(request.Locator, allowEmpty: false);
        Validate(request.Wait);
    }

    public static void ValidateFindAll(FindElementRequest request)
    {
        Validate(request);
        ValidateFindAll(request.Locator);
    }

    public static void ValidateFindAll(UiaLocator locator)
    {
        Validate(locator, allowEmpty: false);
        if (locator.MatchIndex is not null)
        {
            throw Invalid("matchIndex is not allowed for element.findAll because the method returns every match.");
        }
    }

    public static void Validate(ElementBatchQueryRequest request)
    {
        RequireIdentifier(request.SessionId, "sessionId");
        if (request.RootElementId is not null)
        {
            RequireIdentifier(request.RootElementId, "rootElementId");
        }

        if (request.Clauses is null)
        {
            throw Invalid("clauses must not be null.");
        }

        if (request.Clauses.Count is < 1 or > ElementBatchQueryLimits.MaxClauses)
        {
            throw Invalid(
                $"clauses must contain between 1 and {ElementBatchQueryLimits.MaxClauses} locators.");
        }

        for (var index = 0; index < request.Clauses.Count; index++)
        {
            var locator = request.Clauses[index];
            if (locator is null)
            {
                throw Invalid($"clauses[{index}] must not be null.");
            }

            try
            {
                ValidateFindAll(locator);
            }
            catch (HostOperationException exception) when (exception.Code == "invalid_request")
            {
                throw Invalid($"clauses[{index}] is invalid: {exception.Message}");
            }
        }
    }

    public static void Validate(ElementRequest request)
    {
        RequireIdentifier(request.SessionId, "sessionId");
        RequireIdentifier(request.ElementId, "elementId");
    }

    public static void Validate(ElementActionRequest request)
    {
        RequireIdentifier(request.SessionId, "sessionId");
        RequireIdentifier(request.ElementId, "elementId");
        if (request.Action == UiaAction.Unspecified || !Enum.IsDefined(request.Action))
        {
            throw Invalid("action must be an explicitly declared UIA action.");
        }
        if (request.Action == UiaAction.SetValue && request.Value is null)
        {
            throw Invalid("setValue requires a value, including an empty string when clearing a field.");
        }
        if (request.Action != UiaAction.SetValue && request.Value is not null)
        {
            throw Invalid("value is valid only for setValue.");
        }
        if (request.Value?.Contains('\0') == true)
        {
            throw Invalid("value must not contain NUL characters.");
        }
        if (request.ExpectedTarget is null || request.ExpectedTarget.Locator is null)
        {
            throw Invalid("expectedTarget with a complete locator is required for every action.");
        }
        if (request.ExpectedTarget.ProcessId <= 0)
        {
            throw Invalid("expectedTarget.processId must be greater than zero.");
        }
        RequireIdentifier(request.ExpectedTarget.RootElementId, "expectedTarget.rootElementId");
        Validate(request.ExpectedTarget.Locator, allowEmpty: false);
        if (request.ExpectedTarget.Locator.MatchIndex is not null)
        {
            throw Invalid("expectedTarget.locator cannot authorize an action by matchIndex.");
        }
    }
}
