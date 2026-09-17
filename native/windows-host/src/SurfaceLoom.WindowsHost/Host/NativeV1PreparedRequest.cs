using System.Diagnostics;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.Host;

public sealed class NativeV1PreparedRequest : IDisposable
{
    private readonly Func<string, CancellationTokenSource, bool> releaseRegistration;
    private readonly CancellationTokenSource cancellation;
    private bool disposed;

    internal NativeV1PreparedRequest(
        NativeV1Request request,
        long receivedTimestamp,
        Func<string, CancellationTokenSource, bool> releaseRegistration,
        CancellationTokenSource cancellation)
    {
        Request = request;
        ReceivedTimestamp = receivedTimestamp;
        this.releaseRegistration = releaseRegistration;
        this.cancellation = cancellation;
    }

    public NativeV1Request Request { get; }
    public long ReceivedTimestamp { get; }
    public CancellationToken CancellationToken => cancellation.Token;

    public int RemainingMilliseconds()
    {
        var elapsed = Stopwatch.GetElapsedTime(ReceivedTimestamp);
        return Math.Max(0, Request.TimeoutMs - (int)Math.Ceiling(elapsed.TotalMilliseconds));
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        if (releaseRegistration(Request.Id, cancellation))
        {
            cancellation.Dispose();
        }
    }
}
