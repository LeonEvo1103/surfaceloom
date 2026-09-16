using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SurfaceLoom.WindowsHost.Automation;
using SurfaceLoom.WindowsHost.Client;
using SurfaceLoom.WindowsHost.Host;
using SurfaceLoom.WindowsHost.Protocol;

namespace SurfaceLoom.WindowsHost.ContractTests;

internal static partial class ElementContractTests
{
    public static void SemanticPolicyFiltersEveryDeclaredField()
    {
        var roles = new List<string> { "dialog" };
        var actions = new List<UiaAction> { UiaAction.Invoke };
        var toggleStates = new List<string> { "on" };
        var disclosureStates = new List<string> { "collapsed" };
        var policy = new UiaElementSelectionPolicy
        {
            RequireEnabled = true,
            IsReadOnly = false,
            IsSelected = true,
            AriaRoles = roles,
            AnySupportedActions = actions,
            ToggleStates = toggleStates,
            ExpandCollapseStates = disclosureStates,
            StableObservations = 3,
        };
        var selector = new UiaStableElementSelector(policy);
        var eligible = Candidate(
            "eligible",
            isReadOnly: false,
            isSelected: true,
            toggleState: "on",
            expandCollapseState: "collapsed",
            ariaRole: "dialog",
            actions: [UiaAction.Invoke]);
        var candidates = new[]
        {
            eligible,
            Candidate("hidden", isOffscreen: true, isReadOnly: false, isSelected: true,
                toggleState: "on", expandCollapseState: "collapsed", ariaRole: "dialog",
                actions: [UiaAction.Invoke]),
            Candidate("disabled", isEnabled: false, isReadOnly: false, isSelected: true,
                toggleState: "on", expandCollapseState: "collapsed", ariaRole: "dialog",
                actions: [UiaAction.Invoke]),
            Candidate("read-only", isReadOnly: true, isSelected: true, toggleState: "on",
                expandCollapseState: "collapsed", ariaRole: "dialog", actions: [UiaAction.Invoke]),
            Candidate("unselected", isReadOnly: false, isSelected: false, toggleState: "on",
                expandCollapseState: "collapsed", ariaRole: "dialog", actions: [UiaAction.Invoke]),
            Candidate("wrong-role", isReadOnly: false, isSelected: true, toggleState: "on",
                expandCollapseState: "collapsed", ariaRole: "button", actions: [UiaAction.Invoke]),
            Candidate("wrong-action", isReadOnly: false, isSelected: true, toggleState: "on",
                expandCollapseState: "collapsed", ariaRole: "dialog", actions: [UiaAction.Toggle]),
            Candidate("wrong-toggle", isReadOnly: false, isSelected: true, toggleState: "off",
                expandCollapseState: "collapsed", ariaRole: "dialog", actions: [UiaAction.Invoke]),
            Candidate("wrong-disclosure", isReadOnly: false, isSelected: true, toggleState: "on",
                expandCollapseState: "expanded", ariaRole: "dialog", actions: [UiaAction.Invoke]),
        };

        var matches = selector.Eligible(candidates);
        Equal(1, matches.Count, "Every declared policy field must participate in filtering.");
        Equal("eligible", matches[0].ElementId, "Only the fully matching candidate may remain.");

        roles.Clear();
        actions.Clear();
        toggleStates.Clear();
        disclosureStates.Clear();
        Equal(1, selector.Eligible(candidates).Count,
            "A selector must defensively copy mutable policy collections.");
        True(!selector.Observe([eligible], out _), "Three-observation stability must not pass once.");
        True(!selector.Observe([eligible], out _), "Three-observation stability must not pass twice.");
        True(selector.Observe([eligible], out _), "StableObservations must control selection.");
    }

    public static void NullPoliciesRemainFailClosed()
    {
        var defaultSelector = new UiaStableElementSelector(policy: null);
        True(!defaultSelector.Observe([Candidate("hidden", isOffscreen: true)], out _),
            "A null policy must retain the visible-only safe default.");
        True(!defaultSelector.Observe([Candidate("visible")], out _),
            "A null policy must retain consecutive-observation stability.");
        True(defaultSelector.Observe([Candidate("visible")], out _),
            "A null policy may select only after the safe defaults are proven.");

        _ = Throws<ArgumentNullException>(() =>
            new UiaStableElementSelector(new UiaElementSelectionPolicy { AriaRoles = null! }));
        _ = Throws<ArgumentNullException>(() =>
            new UiaStableElementSelector(new UiaElementSelectionPolicy { AnySupportedActions = null! }));
        _ = Throws<ArgumentNullException>(() =>
            new UiaStableElementSelector(new UiaElementSelectionPolicy { ToggleStates = null! }));
        _ = Throws<ArgumentNullException>(() =>
            new UiaStableElementSelector(new UiaElementSelectionPolicy { ExpandCollapseStates = null! }));
        _ = Throws<ArgumentOutOfRangeException>(() =>
            new UiaStableElementSelector(new UiaElementSelectionPolicy { StableObservations = 0 }));
    }

    public static void MissingAriaRoleFallbackIsExplicitAndBounded()
    {
        var strict = new UiaStableElementSelector(new UiaElementSelectionPolicy
        {
            AriaRoles = ["heading"],
        });
        True(strict.Eligible([Candidate("missing-role", ariaRole: null)]).Count == 0,
            "A missing ARIA role must remain ineligible by default.");

        var providerTolerant = new UiaStableElementSelector(new UiaElementSelectionPolicy
        {
            AriaRoles = ["heading"],
            AllowMissingAriaRole = true,
        });
        Equal(1, providerTolerant.Eligible([Candidate("missing-role", ariaRole: null)]).Count,
            "An explicit provider fallback may accept only an unavailable ARIA role.");
        Equal(1, providerTolerant.Eligible([Candidate("heading", ariaRole: "heading")]).Count,
            "The expected exposed ARIA role must remain eligible.");
        Equal(0, providerTolerant.Eligible([Candidate("wrong-role", ariaRole: "button")]).Count,
            "An exposed conflicting ARIA role must still fail closed.");
        Equal(0, providerTolerant.Eligible([Candidate("empty-role", ariaRole: string.Empty)]).Count,
            "An exposed empty ARIA role is not the same as an unsupported optional property.");
        Equal(0, providerTolerant.Eligible([
            Candidate("hidden", isOffscreen: true, ariaRole: null),
        ]).Count,
            "The ARIA fallback must never bypass independent visibility requirements.");
    }

    public static void StableSemanticSelectionIsFailClosed()
    {
        var selector = new UiaStableElementSelector(
            new UiaElementSelectionPolicy { StableObservations = 2 });
        var first = Candidate("first");
        var second = Candidate("second");

        True(!selector.Observe([first], out _),
            "The first unique observation must not establish stability.");
        True(!selector.Observe([first, second], out _),
            "Ambiguity must clear accumulated identity evidence.");
        True(!selector.Observe([first], out _),
            "A candidate must start over after ambiguity.");
        True(selector.Observe([first], out var stable) && stable?.ElementId == "first",
            "One identity may win only after consecutive unique observations.");

        selector.Reset();
        True(!selector.Observe([first], out _), "A reset must discard prior identity evidence.");
        True(!selector.Observe([second], out _), "Identity churn must restart the stability count.");
        True(selector.Observe([second], out var changed) && changed?.ElementId == "second",
            "The replacement identity needs its own complete stability proof.");

        selector.Reset();
        True(!selector.Observe([first], out _), "A fresh identity starts with one observation.");
        True(!selector.Observe([], out _), "Disappearance must clear accumulated identity evidence.");
        True(!selector.Observe([first], out _), "A reappearing identity must start over.");
        True(!selector.Observe([Candidate(" ")], out _),
            "An owner without a stable element handle must never be selected.");
    }

    public static void StableDisappearanceIsFailClosed()
    {
        var absence = new UiaStableAbsenceSelector(requiredObservations: 3);
        var visible = Candidate("visible");
        var hidden = Candidate("hidden", isOffscreen: true);

        True(!absence.Observe([]), "One empty observation is not a stable disappearance.");
        True(!absence.Observe([visible]), "A visible candidate must reset absence evidence.");
        True(!absence.Observe([hidden]), "An ineligible hidden candidate counts as one absence.");
        True(!absence.Observe([]), "Two consecutive absent observations are insufficient.");
        True(absence.Observe([]), "Three consecutive eligible-absent observations prove disappearance.");
        absence.Reset();
        True(!absence.Observe([]), "Reset must discard prior absence evidence.");
        _ = Throws<ArgumentOutOfRangeException>(() =>
            new UiaStableAbsenceSelector(requiredObservations: 0));
    }
}
