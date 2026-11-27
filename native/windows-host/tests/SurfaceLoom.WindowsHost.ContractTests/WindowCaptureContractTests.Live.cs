using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using SurfaceLoom.WindowsHost.Automation;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static partial class WindowCaptureContractTests
{
    private const double WindowWidthDip = 240;
    private const double WindowHeightDip = 160;
    private const int LiveCaptureAttempts = 5;
    private const string LiveCaptureSwitch = "SURFACELOOM_WINDOWS_CAPTURE_LIVE";
    private static readonly Color Expected = Color.FromRgb(0x2E, 0x8B, 0x57);

    /// <summary>
    /// Real capture evidence without an external app: shows a known solid-color WPF window owned by this test
    /// process and captures it through the live PrintWindow path. Opt-in via SURFACELOOM_WINDOWS_CAPTURE_LIVE=1
    /// (reported as SKIP otherwise). Once enabled it requires the unlocked default interactive desktop; when
    /// that is missing the test fails with that reason instead of passing.
    /// </summary>
    public static void CapturesOwnSolidColorWindow()
    {
        // The contract lane is UI-free by default; this test creates a real window only when explicitly enabled.
        if (!string.Equals(Environment.GetEnvironmentVariable(LiveCaptureSwitch), "1", StringComparison.Ordinal))
        {
            throw new ContractTestSkippedException(
                $"creates a real window, so it runs only with {LiveCaptureSwitch}=1 on an unlocked interactive desktop");
        }

        var desktop = InputDesktopInspector.Inspect();
        True(desktop.Accessible && string.Equals(desktop.Name, "Default", StringComparison.OrdinalIgnoreCase),
            $"Live window capture requires the unlocked default interactive desktop; observed accessible={desktop.Accessible}, name={desktop.Name ?? "<none>"}, win32={desktop.Win32Error}.");

        using var scope = new Scope();
        var brush = new SolidColorBrush(Expected);
        var window = new Window
        {
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.Manual,
            // ShowInTaskbar=false would make WPF give the window a hidden owner; an unowned topmost window is
            // the frontmost primary candidate, so no other window of this process can win the selection.
            ShowInTaskbar = true,
            ShowActivated = false,
            Topmost = true,
            Left = 120,
            Top = 120,
            Width = WindowWidthDip,
            Height = WindowHeightDip,
            Background = brush,
            // ContentRendered is never raised for a window without content, so give it a solid child.
            Content = new Border { Background = brush },
            Title = "SurfaceLoom window capture contract",
        };
        try
        {
            var rendered = false;
            window.ContentRendered += (_, _) => rendered = true;
            window.Show();
            True(PumpUntil(() => rendered, TimeSpan.FromSeconds(10)), "The test window never rendered.");
            var handle = new WindowInteropHelper(window).Handle;
            var scale = VisualTreeHelper.GetDpi(window);

            // DWM may not have composed the first frame yet (software rendering on hosted runners), and
            // PW_RENDERFULLCONTENT then yields a blank surface. Only that case is retried, a bounded number
            // of times, each into a new file; every other outcome fails immediately.
            var attempts = new List<string>();
            WindowsWindowCapture? capture = null;
            Color center = default;
            string filePath = string.Empty;
            for (var attempt = 1; attempt <= LiveCaptureAttempts; attempt++)
            {
                PumpUntil(() => false, TimeSpan.FromMilliseconds(250 * attempt));
                filePath = Path.Combine(scope.Directory, "nested", $"window-{attempt}.png");
                var result = CaptureWhilePumping(filePath);
                True(result.Succeeded, $"Live capture must succeed; actual: {result.Outcome} {result.Reason} win32={result.Win32Error}.");
                capture = result.Capture!;
                Equal(handle, capture.WindowHandle, "Selection must pick the test window of this process.");
                center = DecodeCenterPixel(filePath, capture);
                attempts.Add(string.Create(CultureInfo.InvariantCulture,
                    $"#{attempt}: {capture.PixelWidth}x{capture.PixelHeight} center={center} single={capture.SingleColorHex ?? "no"}"));
                if (IsExpectedColor(center))
                {
                    break;
                }
            }

            True(capture is not null && IsExpectedColor(center),
                $"The center pixel is not the window color {Expected} after {LiveCaptureAttempts} captures; the capture is blank or shows another surface. Attempts: {string.Join("; ", attempts)}.");
            Equal(Environment.ProcessId, capture!.ProcessId, "The capture must be bound to this process.");
            var expectedWidth = (int)Math.Round(WindowWidthDip * scale.DpiScaleX);
            var expectedHeight = (int)Math.Round(WindowHeightDip * scale.DpiScaleY);
            True(Math.Abs(capture.PixelWidth - expectedWidth) <= 2 && Math.Abs(capture.PixelHeight - expectedHeight) <= 2,
                $"Captured size {capture.PixelWidth}x{capture.PixelHeight} differs from the window's {expectedWidth}x{expectedHeight} physical pixels.");
            True(!capture.IsSingleColor || string.Equals(capture.SingleColorHex, "#2E8B57", StringComparison.Ordinal),
                $"A single-color fact must report the real color; actual {capture.SingleColorHex}.");

            var before = File.ReadAllBytes(filePath);
            var again = CaptureWhilePumping(filePath);
            Equal(WindowsWindowCaptureOutcome.Failed, again.Outcome, "A live capture must not overwrite its previous file.");
            True(before.AsSpan().SequenceEqual(File.ReadAllBytes(filePath)), "The existing PNG must be unchanged.");
        }
        finally
        {
            window.Close();
            PumpUntil(() => false, TimeSpan.FromMilliseconds(50));
        }
    }

    private static bool IsExpectedColor(Color pixel) =>
        Math.Abs(pixel.R - Expected.R) <= 3 && Math.Abs(pixel.G - Expected.G) <= 3 && Math.Abs(pixel.B - Expected.B) <= 3;

    /// <summary>
    /// The capture runs off the UI thread while this STA thread pumps messages, because the responsiveness probe
    /// and PrintWindow are answered by the window's own thread.
    /// </summary>
    private static WindowsWindowCaptureResult CaptureWhilePumping(string filePath)
    {
        var task = Task.Run(() => WindowsWindowCapturer.CaptureProcessWindow(
            Environment.ProcessId,
            filePath,
            new WindowsWindowCaptureOptions { Timeout = TimeSpan.FromSeconds(10) }));
        True(PumpUntil(() => task.IsCompleted, TimeSpan.FromSeconds(30)), "The bounded capture did not return.");
        return task.GetAwaiter().GetResult();
    }

    private static Color DecodeCenterPixel(string filePath, WindowsWindowCapture capture)
    {
        using var stream = File.OpenRead(filePath);
        var decoder = new PngBitmapDecoder(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        var frame = decoder.Frames[0];
        Equal((capture.PixelWidth, capture.PixelHeight), (frame.PixelWidth, frame.PixelHeight),
            "The decoded PNG size must match the reported pixel size.");
        var converted = new FormatConvertedBitmap(frame, PixelFormats.Bgr32, null, 0);
        var pixel = new byte[4];
        converted.CopyPixels(new Int32Rect(frame.PixelWidth / 2, frame.PixelHeight / 2, 1, 1), pixel, 4, 0);
        return Color.FromRgb(pixel[2], pixel[1], pixel[0]);
    }

    private static bool PumpUntil(Func<bool> condition, TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        while (!condition())
        {
            if (clock.Elapsed >= timeout)
            {
                return false;
            }
            var frame = new DispatcherFrame();
            _ = Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false));
            Dispatcher.PushFrame(frame);
            Thread.Sleep(5);
        }
        return true;
    }
}
