namespace SurfaceLoom.WindowsHost.Host;

public sealed class HostOperationException : Exception
{
    public HostOperationException(string code, string message, object? details = null, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
        Details = details;
    }

    public string Code { get; }
    public object? Details { get; }
}
