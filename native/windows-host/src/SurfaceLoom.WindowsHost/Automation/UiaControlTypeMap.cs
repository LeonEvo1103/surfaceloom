using System.Windows.Automation;
using SurfaceLoom.WindowsHost.Host;

namespace SurfaceLoom.WindowsHost.Automation;

public static class UiaControlTypeMap
{
    private static readonly IReadOnlyDictionary<string, ControlType> ByName =
        new Dictionary<string, ControlType>(StringComparer.OrdinalIgnoreCase)
        {
            ["button"] = ControlType.Button,
            ["calendar"] = ControlType.Calendar,
            ["checkBox"] = ControlType.CheckBox,
            ["comboBox"] = ControlType.ComboBox,
            ["custom"] = ControlType.Custom,
            ["dataGrid"] = ControlType.DataGrid,
            ["dataItem"] = ControlType.DataItem,
            ["document"] = ControlType.Document,
            ["edit"] = ControlType.Edit,
            ["group"] = ControlType.Group,
            ["header"] = ControlType.Header,
            ["headerItem"] = ControlType.HeaderItem,
            ["hyperlink"] = ControlType.Hyperlink,
            ["image"] = ControlType.Image,
            ["list"] = ControlType.List,
            ["listItem"] = ControlType.ListItem,
            ["menu"] = ControlType.Menu,
            ["menuBar"] = ControlType.MenuBar,
            ["menuItem"] = ControlType.MenuItem,
            ["pane"] = ControlType.Pane,
            ["progressBar"] = ControlType.ProgressBar,
            ["radioButton"] = ControlType.RadioButton,
            ["scrollBar"] = ControlType.ScrollBar,
            ["separator"] = ControlType.Separator,
            ["slider"] = ControlType.Slider,
            ["spinner"] = ControlType.Spinner,
            ["splitButton"] = ControlType.SplitButton,
            ["statusBar"] = ControlType.StatusBar,
            ["tab"] = ControlType.Tab,
            ["tabItem"] = ControlType.TabItem,
            ["table"] = ControlType.Table,
            ["text"] = ControlType.Text,
            ["thumb"] = ControlType.Thumb,
            ["titleBar"] = ControlType.TitleBar,
            ["toolBar"] = ControlType.ToolBar,
            ["toolTip"] = ControlType.ToolTip,
            ["tree"] = ControlType.Tree,
            ["treeItem"] = ControlType.TreeItem,
            ["window"] = ControlType.Window,
        };

    public static IReadOnlyList<string> Names { get; } =
        ByName.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();

    public static ControlType Resolve(string name)
    {
        if (ByName.TryGetValue(name, out var controlType))
        {
            return controlType;
        }

        throw new HostOperationException(
            "invalid_locator",
            $"Unknown UIA control type '{name}'.",
            new { supported = Names });
    }

    public static string GetName(ControlType controlType)
    {
        foreach (var pair in ByName)
        {
            if (pair.Value == controlType)
            {
                return pair.Key;
            }
        }

        return controlType.ProgrammaticName;
    }
}
