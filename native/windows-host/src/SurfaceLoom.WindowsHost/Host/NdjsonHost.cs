using System.IO;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

public sealed class NdjsonHost
{
    private readonly TextReader input;
    private readonly TextWriter output;
    private readonly TextWriter diagnostics;

    public NdjsonHost(TextReader input, TextWriter output, TextWriter diagnostics)
    {
        this.input = input;
        this.output = output;
        this.diagnostics = diagnostics;
    }

    public int Run(CancellationToken cancellationToken)
    {
        using var dispatcher = new RequestDispatcher();

        while (!cancellationToken.IsCancellationRequested)
        {
            var line = input.ReadLine();
            if (line is null)
            {
                return 0;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var response = HandleLine(dispatcher, line);
            output.WriteLine(JsonSerializer.Serialize(response, JsonDefaults.Options));
            output.Flush();
        }

        return 0;
    }

    private RpcResponse HandleLine(RequestDispatcher dispatcher, string line)
    {
        RpcRequest? request = null;
        try
        {
            request = JsonSerializer.Deserialize<RpcRequest>(line, JsonDefaults.Options);
            if (request is null)
            {
                throw new HostOperationException("invalid_request", "Request must be a JSON object.");
            }

            var result = dispatcher.Dispatch(request);
            return RpcResponse.Success(request.Id, result);
        }
        catch (HostOperationException exception)
        {
            return RpcResponse.Failure(
                request?.Id ?? string.Empty,
                new RpcError(exception.Code, exception.Message, exception.Details));
        }
        catch (JsonException exception)
        {
            return RpcResponse.Failure(
                request?.Id ?? string.Empty,
                new RpcError("invalid_json", exception.Message));
        }
        catch (Exception exception)
        {
            diagnostics.WriteLine($"Unhandled host error: {exception}");
            diagnostics.Flush();
            return RpcResponse.Failure(
                request?.Id ?? string.Empty,
                new RpcError("host_internal_error", "The Windows host failed unexpectedly; inspect stderr."));
        }
    }
}
