using System.ComponentModel;
using System.Windows;
using SurfaceLoom.WindowsFixture.Model;

namespace SurfaceLoom.WindowsFixture;

public partial class MainWindow : Window
{
    private readonly FixtureState _state = new();

    public MainWindow()
    {
        InitializeComponent();
        DataContext = _state;
        Closing += MainWindow_Closing;
    }

    private void InvokeButton_Click(object sender, RoutedEventArgs e) => _state.RecordInvoke();

    private void AmbiguousButton_Click(object sender, RoutedEventArgs e) =>
        _state.RecordAmbiguousInvocation();

    private void TransientButton_Click(object sender, RoutedEventArgs e)
    {
        if (_state.DismissTransient())
        {
            TransientHost.Children.Remove(TransientActionButton);
        }
    }

    private void RestoreTransientButton_Click(object sender, RoutedEventArgs e)
    {
        if (_state.RestoreTransient())
        {
            TransientHost.Children.Insert(0, TransientActionButton);
        }
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e)
    {
        _state.BeginClosing();
        Close();
    }

    private void MainWindow_Closing(object? sender, CancelEventArgs e) => _state.BeginClosing();
}
