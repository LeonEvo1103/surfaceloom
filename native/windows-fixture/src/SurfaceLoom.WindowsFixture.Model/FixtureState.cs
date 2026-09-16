using System.ComponentModel;
using System.Globalization;
using System.Runtime.CompilerServices;

namespace SurfaceLoom.WindowsFixture.Model;

public sealed class FixtureState : INotifyPropertyChanged
{
    private int _invokeCount;
    private string _inputValue = string.Empty;
    private int _ambiguousInvocationCount;
    private bool _isTransientVisible = true;
    private string _lifecycleState = "ready";

    public event PropertyChangedEventHandler? PropertyChanged;

    public int InvokeCount => _invokeCount;
    public string InvokeCountText => _invokeCount.ToString(CultureInfo.InvariantCulture);

    public string InputValue
    {
        get => _inputValue;
        set
        {
            ArgumentNullException.ThrowIfNull(value);
            if (_inputValue == value)
            {
                return;
            }

            _inputValue = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ValueMirror));
        }
    }

    public string ValueMirror => _inputValue;
    public int AmbiguousInvocationCount => _ambiguousInvocationCount;
    public string AmbiguousInvocationCountText =>
        _ambiguousInvocationCount.ToString(CultureInfo.InvariantCulture);
    public bool IsTransientVisible => _isTransientVisible;
    public string LifecycleState => _lifecycleState;

    public void RecordInvoke()
    {
        checked
        {
            _invokeCount++;
        }

        OnPropertyChanged(nameof(InvokeCount));
        OnPropertyChanged(nameof(InvokeCountText));
    }

    public void RecordAmbiguousInvocation()
    {
        checked
        {
            _ambiguousInvocationCount++;
        }

        OnPropertyChanged(nameof(AmbiguousInvocationCount));
        OnPropertyChanged(nameof(AmbiguousInvocationCountText));
    }

    public bool DismissTransient()
    {
        if (!_isTransientVisible)
        {
            return false;
        }

        _isTransientVisible = false;
        OnPropertyChanged(nameof(IsTransientVisible));
        return true;
    }

    public bool RestoreTransient()
    {
        if (_isTransientVisible)
        {
            return false;
        }

        _isTransientVisible = true;
        OnPropertyChanged(nameof(IsTransientVisible));
        return true;
    }

    public void BeginClosing()
    {
        if (_lifecycleState == "closing")
        {
            return;
        }

        _lifecycleState = "closing";
        OnPropertyChanged(nameof(LifecycleState));
    }

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
