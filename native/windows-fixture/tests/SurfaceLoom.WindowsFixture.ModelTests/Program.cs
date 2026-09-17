using SurfaceLoom.WindowsFixture.Model;

var failures = new List<string>();
var checks = 0;

void Check(bool condition, string message)
{
    checks++;
    if (!condition)
    {
        failures.Add(message);
    }
}

var state = new FixtureState();
Check(state.InvokeCount == 0, "invoke count starts at zero");
Check(state.InputValue == string.Empty, "input starts empty");
Check(state.ValueMirror == string.Empty, "mirror starts empty");
Check(state.AmbiguousInvocationCount == 0, "ambiguous count starts at zero");
Check(state.IsTransientVisible, "transient control starts visible");
Check(state.LifecycleState == "ready", "lifecycle starts ready");

state.RecordInvoke();
state.RecordInvoke();
Check(state.InvokeCount == 2 && state.InvokeCountText == "2", "invoke increments exactly once");

state.InputValue = "SurfaceLoom value ✓";
Check(state.ValueMirror == "SurfaceLoom value ✓", "value mirror preserves exact input");

state.RecordAmbiguousInvocation();
Check(state.AmbiguousInvocationCount == 1, "an explicit ambiguous button invocation is observable");

Check(state.DismissTransient(), "first dismissal changes state");
Check(!state.IsTransientVisible, "dismissal hides transient control");
Check(!state.DismissTransient(), "repeated dismissal is a no-op");
Check(state.RestoreTransient(), "restore changes hidden state");
Check(state.IsTransientVisible, "restore returns baseline");
Check(!state.RestoreTransient(), "repeated restore is a no-op");

state.BeginClosing();
state.BeginClosing();
Check(state.LifecycleState == "closing", "closing transition is stable");

if (failures.Count > 0)
{
    foreach (var failure in failures)
    {
        Console.Error.WriteLine($"FAIL: {failure}");
    }

    return 1;
}

Console.WriteLine($"SurfaceLoom Windows fixture model: {checks} checks passed.");
return 0;
