using System.IO;
using SurfaceLoom.WindowsHost.Automation;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static partial class WindowCaptureContractTests
{
    private static readonly byte[] MinimalPng = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    public static void UnavailableEnvironmentNeverCaptures()
    {
        foreach (var desktop in new[]
                 {
                     new InputDesktopInspection(false, null, 5, "Access is denied."),
                     new InputDesktopInspection(true, "Winlogon", null, null),
                 })
        {
            using var scope = new Scope();
            var fake = new Fake { Desktop = desktop };
            var result = scope.Capture(fake);
            Equal(WindowsWindowCaptureOutcome.EnvironmentUnavailable, result.Outcome,
                "A locked session or secure desktop must be a typed unavailable result.");
            Equal(0, fake.ListCalls + fake.ImageCalls, "No window may be enumerated or printed off the default desktop.");
            True(!File.Exists(scope.FilePath), "No image may be produced off the default desktop.");
        }
    }

    public static void CaptureFailuresAreTypedAndLeaveNoFile()
    {
        var cases = new (WindowImageOutcome Image, WindowsWindowCaptureOutcome Expected, string Reason)[]
        {
            (new(WindowImageOutcomeKind.Failed, null, "PrintWindow returned FALSE"),
                WindowsWindowCaptureOutcome.Failed, "PrintWindow returned FALSE"),
            (new(WindowImageOutcomeKind.TimedOut, null, "the window is hung or did not answer WM_NULL"),
                WindowsWindowCaptureOutcome.TimedOut, "did not answer WM_NULL"),
            (new(WindowImageOutcomeKind.WindowUnavailable, null, "the selected window was destroyed"),
                WindowsWindowCaptureOutcome.NoCapturableWindow, "destroyed"),
            (new(WindowImageOutcomeKind.Image, new WindowImage(0, 10, MinimalPng, false, null), null),
                WindowsWindowCaptureOutcome.Failed, "no pixels"),
            (new(WindowImageOutcomeKind.Image, new WindowImage(640, 30, MinimalPng, false, null), null),
                WindowsWindowCaptureOutcome.NoCapturableWindow, "smaller than 40x40 px"),
        };
        foreach (var (image, expected, reason) in cases)
        {
            using var scope = new Scope();
            var fake = new Fake { Image = image };
            var result = scope.Capture(fake);
            Equal(expected, result.Outcome, $"Image outcome '{image.Reason}' was not mapped honestly.");
            True(result.Reason?.Contains(reason, StringComparison.Ordinal) == true,
                $"The result must explain '{reason}'; actual: {result.Reason}.");
            Equal(0, fake.WriteCalls, "A failed capture must never write the destination.");
            True(result.Capture is null && !File.Exists(scope.FilePath), "A failed capture must not produce a file.");
        }

        using var noWindow = new Scope();
        var minimized = new Fake { Windows = [Window(0x10, minimized: true)] };
        var none = noWindow.Capture(minimized);
        Equal(WindowsWindowCaptureOutcome.NoCapturableWindow, none.Outcome, "A minimized-only app has no capturable window.");
        Equal(0, minimized.ImageCalls, "A minimized window must never be printed.");
    }

    public static void InvalidRequestsFailBeforeTouchingTheDesktop()
    {
        using var scope = new Scope();
        var fake = new Fake();
        var relative = WindowsWindowCapturer.Capture(Pid, "shot.png", new WindowsWindowCaptureOptions(), fake.Build());
        var noTimeout = WindowsWindowCapturer.Capture(Pid, scope.FilePath,
            new WindowsWindowCaptureOptions { Timeout = TimeSpan.Zero }, fake.Build());
        var unbound = WindowsWindowCapturer.Capture(0, scope.FilePath, new WindowsWindowCaptureOptions(), fake.Build());
        Equal(WindowsWindowCaptureOutcome.Failed, relative.Outcome, "Relative destinations must be rejected.");
        Equal(WindowsWindowCaptureOutcome.Failed, noTimeout.Outcome, "A capture without a timeout must be rejected.");
        Equal(WindowsWindowCaptureOutcome.NoCapturableWindow, unbound.Outcome, "An unbound process has no window.");
        Equal(0, fake.DesktopCalls + fake.ListCalls + fake.ImageCalls, "Invalid requests must not inspect anything.");
    }

    public static void FilesAreNeverOverwrittenAndFailuresAreCleanedUp()
    {
        using (var scope = new Scope())
        {
            Directory.CreateDirectory(Path.GetDirectoryName(scope.FilePath)!);
            File.WriteAllText(scope.FilePath, "keep");
            var fake = new Fake();
            var result = scope.Capture(fake);
            Equal(WindowsWindowCaptureOutcome.Failed, result.Outcome, "An existing destination must fail.");
            Equal("keep", File.ReadAllText(scope.FilePath), "An existing destination must be left untouched.");
            Equal(0, fake.ImageCalls, "No capture may run for an existing destination.");

            var race = WindowsPngFileStore.Write(scope.FilePath, MinimalPng);
            True(!race.Succeeded && race.AlreadyExisted && !race.CreatedFile,
                "The real writer must refuse a file that appears after the pre-check.");
            Equal("keep", File.ReadAllText(scope.FilePath), "The real writer must never truncate an existing file.");
        }

        using (var scope = new Scope())
        {
            var fake = new Fake
            {
                Write = (path, _) =>
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    File.WriteAllBytes(path, [0x89, 0x50]);
                    return new PngWriteOutcome(false, true, false, "disk full");
                },
            };
            var result = scope.Capture(fake);
            Equal(WindowsWindowCaptureOutcome.Failed, result.Outcome, "A failed write must fail the capture.");
            True(!File.Exists(scope.FilePath), "A partially written file must be removed.");
        }

        using (var scope = new Scope())
        {
            var fake = new Fake { Image = ImageOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]) };
            var result = scope.Capture(fake);
            Equal(WindowsWindowCaptureOutcome.Failed, result.Outcome, "Bytes without a PNG signature are not a capture.");
            True(!File.Exists(scope.FilePath), "A file that fails PNG verification must be removed.");
            True(WindowsPngFileStore.VerifiedByteCount(Path.Combine(scope.Directory, "missing.png")) is null,
                "A missing file is never verified.");
        }
    }

    public static void VerifiedCaptureReportsFacts()
    {
        using var scope = new Scope();
        var capturedAt = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var fake = new Fake { Image = ImageOf(MinimalPng, singleColor: "#000000"), Now = capturedAt };
        var result = scope.Capture(fake);
        True(result.Succeeded, $"A verified PNG must be captured; actual: {result.Outcome} {result.Reason}.");
        var capture = result.Capture!;
        Equal(scope.FilePath, capture.FilePath, "The capture must report its file.");
        Equal((long)MinimalPng.Length, capture.ByteCount, "The byte count must come from the file on disk.");
        Equal((640, 480), (capture.PixelWidth, capture.PixelHeight), "Pixel size must be reported.");
        Equal((nint)0x10, capture.WindowHandle, "The captured window must be reported.");
        Equal(Pid, capture.ProcessId, "The captured process must be reported.");
        Equal(capturedAt, capture.CapturedAt, "The timestamp must be reported.");
        True(capture.IsSingleColor && capture.SingleColorHex == "#000000",
            "A single-color frame must be kept but flagged, never silently passed off as normal.");
        True(File.Exists(scope.FilePath), "Missing parent directories must be created.");
    }

    public static void SingleColorFactIgnoresAlphaAndPadding()
    {
        byte[] uniform = [10, 20, 30, 0, 10, 20, 30, 255, 9, 9, 10, 20, 30, 7, 10, 20, 30, 1, 9, 9];
        var (single, hex) = WindowsPngFileStore.SingleColor(uniform, 2, 2, 10);
        True(single && hex == "#1E140A", "Alpha bytes and row padding must not affect the single-color fact.");
        uniform[14] = 31;
        True(!WindowsPngFileStore.SingleColor(uniform, 2, 2, 10).IsSingleColor, "One differing pixel must clear the fact.");
        True(!WindowsPngFileStore.SingleColor(uniform, 3, 2, 10).IsSingleColor, "A short buffer must not be reported as uniform.");
    }

    private static WindowImageOutcome ImageOf(byte[] png, string? singleColor = null) =>
        new(WindowImageOutcomeKind.Image, new WindowImage(640, 480, png, singleColor is not null, singleColor), null);

    private sealed class Fake
    {
        public InputDesktopInspection Desktop { get; init; } = new(true, "Default", null, null);
        public WindowsWindowDescriptor[] Windows { get; init; } = [Window(0x10)];
        public WindowImageOutcome Image { get; init; } = ImageOf(MinimalPng);
        public Func<string, byte[], PngWriteOutcome> Write { get; init; } = WindowsPngFileStore.Write;
        public DateTimeOffset Now { get; init; } = DateTimeOffset.UnixEpoch;
        public int DesktopCalls { get; private set; }
        public int ListCalls { get; private set; }
        public int ImageCalls { get; private set; }
        public int WriteCalls { get; private set; }

        public WindowsWindowCaptureDependencies Build() => new(
            () => { DesktopCalls++; return Desktop; },
            _ => { ListCalls++; return Windows; },
            (_, _) => { ImageCalls++; return Image; },
            (path, bytes) => { WriteCalls++; return Write(path, bytes); },
            WindowsPngFileStore.VerifiedByteCount,
            File.Exists,
            WindowsPngFileStore.Remove,
            () => Now);
    }

    private sealed class Scope : IDisposable
    {
        public string Directory { get; } =
            Path.Combine(Path.GetTempPath(), "surfaceloom-capture-" + Guid.NewGuid().ToString("N"));

        public string FilePath => Path.Combine(Directory, "nested", "window.png");

        public WindowsWindowCaptureResult Capture(Fake fake) =>
            WindowsWindowCapturer.Capture(Pid, FilePath, new WindowsWindowCaptureOptions(), fake.Build());

        public void Dispose()
        {
            try
            {
                if (System.IO.Directory.Exists(Directory)) System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // Best effort: a transient lock on a temp file must not replace the test's own failure.
            }
        }
    }
}
