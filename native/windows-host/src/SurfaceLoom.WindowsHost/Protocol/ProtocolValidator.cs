using System.IO;
using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Protocol;

public static partial class ProtocolValidator
{
    public static void ValidateRequest(RpcRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
        {
            throw Invalid("Request id must not be empty.");
        }

        if (string.IsNullOrWhiteSpace(request.Method))
        {
            throw Invalid("Request method must not be empty.");
        }

        if (!string.Equals(request.ProtocolVersion, HostProtocol.Version, StringComparison.Ordinal))
        {
            throw new HostOperationException(
                "protocol_version_mismatch",
                $"Host supports protocol {HostProtocol.Version}, but request used {request.ProtocolVersion}.",
                new { supported = HostProtocol.Version, received = request.ProtocolVersion });
        }
    }

    public static void Validate(AttachSessionRequest request)
    {
        if (request.ProcessId <= 0)
        {
            throw Invalid("processId must be greater than zero.");
        }

        if (request.Wait is null)
        {
            throw Invalid("wait must be an object when provided.");
        }

        Validate(request.Wait);
        if (request.Window is not null)
        {
            Validate(request.Window, allowEmpty: true);
        }
    }

    public static void Validate(LaunchSessionRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.ExecutablePath))
        {
            throw Invalid("executablePath must not be empty.");
        }

        if (!Path.IsPathFullyQualified(request.ExecutablePath))
        {
            throw Invalid("executablePath must be an absolute path.");
        }

        if (request.WorkingDirectory is not null &&
            !Path.IsPathFullyQualified(request.WorkingDirectory))
        {
            throw Invalid("workingDirectory must be an absolute path when provided.");
        }

        if (request.Arguments is null || request.Environment is null || request.Wait is null)
        {
            throw Invalid("arguments, environment, and wait must not be null.");
        }

        if (request.Arguments.Any(argument =>
                argument is null || argument.Contains('\0')))
        {
            throw Invalid("arguments must not contain null values or NUL characters.");
        }

        if (request.Environment.Any(variable =>
                string.IsNullOrWhiteSpace(variable.Key) ||
                variable.Key.Contains('=') ||
                variable.Key.Contains('\0') ||
                variable.Value is null ||
                variable.Value.Contains('\0')))
        {
            throw Invalid("environment contains an invalid name or value.");
        }

        if (!request.WaitForWindow && request.Window is not null)
        {
            throw Invalid("window cannot be supplied when waitForWindow is false.");
        }

        Validate(request.Wait);
        if (request.Window is not null)
        {
            Validate(request.Window, allowEmpty: true);
        }
    }

    public static void Validate(SessionRequest request) =>
        RequireIdentifier(request.SessionId, "sessionId");

    public static void Validate(ProcessEndRequest request)
    {
        RequireIdentifier(request.SessionId, "sessionId");
        if (request.Wait is null)
        {
            throw Invalid("wait must not be null.");
        }

        Validate(request.Wait);
    }

    private static void RequireIdentifier(string value, string property)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw Invalid($"{property} must not be empty.");
        }
    }

    private static HostOperationException Invalid(string message) =>
        new("invalid_request", message);
}
