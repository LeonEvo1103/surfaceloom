using System.Text;
using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost;

public static class Program
{
    [STAThread]
    public static int Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine(
                "SurfaceLoom.WindowsHost requires Windows and an interactive desktop session.");
            return 2;
        }

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };

        var host = new NdjsonHost(Console.In, Console.Out, Console.Error);
        return host.Run(cancellation.Token);
    }
}
