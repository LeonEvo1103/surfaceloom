namespace SurfaceLoom.WindowsHost.Protocol;

public sealed class NativeV1ProtocolException : Exception
{
    public NativeV1ProtocolException(
        string code,
        string category,
        string safeMessage,
        string requestId = "invalid",
        object? details = null)
        : base(safeMessage)
    {
        Code = code;
        Category = category;
        RequestId = requestId;
        Details = details;
    }

    public string Code { get; }
    public string Category { get; }
    public string RequestId { get; }
    public object? Details { get; }
}
