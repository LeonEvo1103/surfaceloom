using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

public sealed class NdjsonHost
{
    private static readonly TimeSpan ReaderShutdownGrace = TimeSpan.FromMilliseconds(250);
    private readonly TextReader input;
    private readonly TextWriter output;
    private readonly TextWriter diagnostics;
    private readonly object outputGate = new();
    private readonly NativeV1Dispatcher? injectedNative;

    public NdjsonHost(TextReader input, TextWriter output, TextWriter diagnostics)
    {
        this.input = input;
        this.output = output;
        this.diagnostics = diagnostics;
    }

    internal NdjsonHost(
        TextReader input,
        TextWriter output,
        TextWriter diagnostics,
        NativeV1Dispatcher native)
        : this(input, output, diagnostics)
    {
        injectedNative = native;
    }

    public int Run(CancellationToken cancellationToken)
    {
        using var legacy = new RequestDispatcher();
        using var native = injectedNative ?? new NativeV1Dispatcher();
        using var inbound = new BlockingCollection<InboundItem>();
        using var wakeReader = cancellationToken.Register(() => WakeForShutdown(inbound));
        var reader = Task.Factory.StartNew(
            () => ReadFrames(native, inbound, cancellationToken),
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default);

        try
        {
            foreach (var item in inbound.GetConsumingEnumerable())
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                switch (item)
                {
                    case LegacyItem legacyItem:
                        WriteLegacyResponse(HandleLegacyLine(legacy, legacyItem.Line));
                        break;
                    case NativeItem nativeItem:
                        WriteNativeResponse(native, nativeItem.Prepared);
                        break;
                    case NativeResponseItem responseItem:
                        WriteNativeFrame(NativeV1OutboundSerializer.Serialize(responseItem.Response));
                        break;
                    default:
                        throw new InvalidOperationException("Unknown inbound host item.");
                }
            }

            if (!cancellationToken.IsCancellationRequested)
            {
                reader.GetAwaiter().GetResult();
            }
            else if (!reader.Wait(ReaderShutdownGrace))
            {
                WriteSafeDiagnostic("Native input reader did not acknowledge cancellation; it was detached after input closure.");
            }
            return 0;
        }
        finally
        {
            while (inbound.TryTake(out var item))
            {
                if (item is NativeItem nativeItem)
                {
                    nativeItem.Prepared.Dispose();
                }
            }
        }
    }

    private void WakeForShutdown(BlockingCollection<InboundItem> inbound)
    {
        // A generic synchronous TextReader cannot be interrupted safely, and Console.In may
        // serialize Dispose behind the blocking Read. Wake the STA consumer immediately instead.
        // The reader sees the token before it can publish another frame; if Read never returns,
        // the background reader is detached after a bounded grace period.
        CompleteAdding(inbound);
    }

    private void ReadFrames(
        NativeV1Dispatcher native,
        BlockingCollection<InboundItem> inbound,
        CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var frame = ReadWireLine();
                if (frame is null || cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                if (string.IsNullOrWhiteSpace(frame.Line))
                {
                    continue;
                }
                if (!IngestFrame(native, inbound, frame, Stopwatch.GetTimestamp()))
                {
                    return;
                }
            }
        }
        catch (Exception exception) when (cancellationToken.IsCancellationRequested &&
            exception is IOException or ObjectDisposedException or InvalidOperationException)
        {
            // Expected wake-up path: the cancellation callback closed input and the queue.
        }
        catch (Exception exception)
        {
            WriteSafeDiagnostic($"Native input reader stopped safely: {exception.GetType().Name}.");
        }
        finally
        {
            CompleteAdding(inbound);
        }
    }

    private bool IngestFrame(
        NativeV1Dispatcher native,
        BlockingCollection<InboundItem> inbound,
        WireLine frame,
        long receivedTimestamp)
    {
        JsonDocument document;
        try
        {
            document = NativeV1Parser.ParseFrame(frame.Line, frame.DelimiterBytes);
        }
        catch (NativeV1ProtocolException)
        {
            WriteSafeDiagnostic("Native input connection closed after an unrouteable or oversized frame.");
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                WriteSafeDiagnostic("Native input connection closed because the frame envelope was not an object.");
                return false;
            }
            var nativeMarkerCount = root.EnumerateObject().Count(property => property.NameEquals("protocol"));
            var legacyMarkerCount = root.EnumerateObject().Count(property => property.NameEquals("protocolVersion"));
            if (nativeMarkerCount + legacyMarkerCount != 1)
            {
                WriteSafeDiagnostic("Native input connection closed because the protocol envelope was ambiguous.");
                return false;
            }
            if (legacyMarkerCount == 1)
            {
                root.TryGetProperty("protocolVersion", out var legacyVersion);
                if (legacyVersion.ValueKind != JsonValueKind.String || legacyVersion.GetString() != HostProtocol.Version)
                {
                    WriteSafeDiagnostic("Native input connection closed because the legacy protocol marker was unsupported.");
                    return false;
                }
                return TryAdd(inbound, new LegacyItem(frame.Line));
            }
            root.TryGetProperty("protocol", out var protocol);
            if (protocol.ValueKind != JsonValueKind.String || protocol.GetString() != NativeV1Protocol.Name)
            {
                WriteSafeDiagnostic("Native input connection closed because the shared protocol marker was unsupported.");
                return false;
            }
            return IngestNativeFrame(native, inbound, root, receivedTimestamp);
        }
    }

    private bool IngestNativeFrame(
        NativeV1Dispatcher native,
        BlockingCollection<InboundItem> inbound,
        JsonElement root,
        long receivedTimestamp)
    {
        NativeV1Request? parsedRequest = null;
        var candidateId = NativeV1Parser.TryReadMessageId(root);
        if (candidateId is not null && native.IsOutstanding(candidateId))
        {
            WriteSafeDiagnostic("Native input connection closed to preserve an outstanding request's terminal response.");
            return false;
        }
        try
        {
            var messageType = NativeV1Parser.ReadMessageType(root);
            if (messageType == "cancel")
            {
                native.Cancel(NativeV1Parser.ParseCancel(root));
                return true;
            }
            if (messageType != "request")
            {
                throw new NativeV1ProtocolException(
                    "invalid_message", "invalidRequest", "Clients may send only request or cancel frames.",
                    candidateId ?? "invalid");
            }
            parsedRequest = NativeV1Parser.ParseRequest(root);
            return TryAdd(inbound, new NativeItem(native.Prepare(parsedRequest, receivedTimestamp)));
        }
        catch (NativeV1ProtocolException exception)
        {
            if (native.IsOutstanding(candidateId ?? exception.RequestId))
            {
                WriteSafeDiagnostic("Native input connection closed to preserve an outstanding request's terminal response.");
                return false;
            }
            TryAdd(inbound, new NativeResponseItem(new NativeV1Response
            {
                Id = exception.RequestId,
                Ok = false,
                Error = new NativeV1Error(
                    exception.Code,
                    exception.Category,
                    exception.Message,
                    "never",
                    exception.Details),
                Operation = parsedRequest?.Call.Intent is "mutate" or "lifecycle"
                    ? new NativeV1OperationReceipt(parsedRequest.Call.OperationId!, "notExecuted")
                    : null,
            }));
            // Schema failure gets one bounded v1 response, then intake closes. This prevents
            // later frames from reusing the same correlation id before that response is written.
            return false;
        }
    }

    private WireLine? ReadWireLine()
    {
        var line = new StringBuilder();
        var overCharacterLimit = false;
        while (true)
        {
            var next = input.Read();
            if (next < 0)
            {
                return line.Length == 0 && !overCharacterLimit ? null : new WireLine(line.ToString(), 1);
            }
            if (next == '\n')
            {
                if (line.Length > 0 && line[^1] == '\r')
                {
                    line.Length--;
                    return new WireLine(line.ToString(), 2);
                }
                return new WireLine(line.ToString(), 1);
            }
            if (line.Length <= NativeV1Protocol.MaxMessageBytes)
            {
                line.Append((char)next);
            }
            else
            {
                overCharacterLimit = true;
            }
        }
    }

    private RpcResponse HandleLegacyLine(RequestDispatcher dispatcher, string line)
    {
        RpcRequest? request = null;
        try
        {
            request = JsonSerializer.Deserialize<RpcRequest>(line, JsonDefaults.Options);
            if (request is null)
            {
                throw new HostOperationException("invalid_request", "Request must be a JSON object.");
            }
            return RpcResponse.Success(request.Id, dispatcher.Dispatch(request));
        }
        catch (HostOperationException exception)
        {
            return RpcResponse.Failure(
                request?.Id ?? string.Empty,
                new RpcError(exception.Code, exception.Message, exception.Details));
        }
        catch (JsonException exception)
        {
            return RpcResponse.Failure(request?.Id ?? string.Empty, new RpcError("invalid_json", exception.Message));
        }
        catch (Exception exception)
        {
            WriteSafeDiagnostic($"Unhandled legacy host error: {exception.GetType().Name}.");
            return RpcResponse.Failure(
                request?.Id ?? string.Empty,
                new RpcError("host_internal_error", "The Windows host failed unexpectedly; inspect stderr."));
        }
    }

    private void WriteNativeResponse(NativeV1Dispatcher native, NativeV1PreparedRequest prepared)
    {
        try
        {
            WriteNativeFrame(native.ExecuteOutbound(prepared));
        }
        finally
        {
            prepared.Dispose();
        }
    }

    private void WriteNativeFrame(NativeV1OutboundFrame frame)
    {
        lock (outputGate)
        {
            output.Write(frame.Line);
            output.Flush();
        }
    }

    private void WriteLegacyResponse(RpcResponse response)
    {
        lock (outputGate)
        {
            output.WriteLine(JsonSerializer.Serialize(response, JsonDefaults.Options));
            output.Flush();
        }
    }

    private void WriteSafeDiagnostic(string message)
    {
        lock (diagnostics)
        {
            diagnostics.WriteLine(message);
            diagnostics.Flush();
        }
    }

    private static bool TryAdd(BlockingCollection<InboundItem> inbound, InboundItem item)
    {
        var added = false;
        try
        {
            inbound.Add(item);
            added = true;
            return true;
        }
        catch (Exception exception) when (exception is InvalidOperationException or ObjectDisposedException)
        {
            return false;
        }
        finally
        {
            if (!added && item is NativeItem nativeItem)
            {
                nativeItem.Prepared.Dispose();
            }
        }
    }

    private static void CompleteAdding(BlockingCollection<InboundItem> inbound)
    {
        try
        {
            if (!inbound.IsAddingCompleted)
            {
                inbound.CompleteAdding();
            }
        }
        catch (ObjectDisposedException)
        {
            // A detached reader may finish after the host has already returned from cancellation.
        }
    }

    private sealed record WireLine(string Line, int DelimiterBytes);
    private abstract record InboundItem;
    private sealed record LegacyItem(string Line) : InboundItem;
    private sealed record NativeItem(NativeV1PreparedRequest Prepared) : InboundItem;
    private sealed record NativeResponseItem(NativeV1Response Response) : InboundItem;
}
