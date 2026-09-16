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
    public static void SafeDiagnosticsRemainBounded()
    {
        const string privateSentinel = "PRIVATE_CHAT_SENTINEL";
        const string privateEmail = "alice@example.test";
        const string privatePhone = "+86-138-0013-8000";
        var locator = new UiaSafeLocatorConstraints(
            "settings.open",
            ["Settings"],
            ["known-id"],
            ["known-class"]);
        var candidates = Enumerable.Range(0, 12).Select(index => index == 0
            ? new UiaSafeCandidate(
                "Settings",
                "known-id",
                "button",
                "known-class",
                true,
                false,
                "dialog",
                ["setValue", "invoke", "invoke", "private-action"])
            : new UiaSafeCandidate(
                index == 1 ? privateEmail : $"{privateSentinel}-name-{index}",
                index == 1 ? privatePhone : $"{privateSentinel}-id-{index}",
                $"{privateSentinel}-type-{index}",
                index == 1 ? privateEmail : $"{privateSentinel}-class-{index}",
                true,
                index > 1,
                $"{privateSentinel}-role-{index}",
                ["private-action"])).ToArray();
        var diagnostic = UiaSafeDiagnosticFormatter.Format(
            locator,
            "element_ambiguous",
            12,
            candidates);

        True(diagnostic.Length <= UiaSafeDiagnosticFormatter.MaxOutputCharacters,
            "Diagnostics must have a hard size bound.");
        var privateEmailShaPrefix = Sha256Prefix(privateEmail);
        var privatePhoneShaPrefix = Sha256Prefix(privatePhone);
        True(!diagnostic.Contains(privateSentinel, StringComparison.Ordinal) &&
             !diagnostic.Contains(privateEmail, StringComparison.Ordinal) &&
             !diagnostic.Contains(privatePhone, StringComparison.Ordinal) &&
             !diagnostic.Contains(privateEmailShaPrefix, StringComparison.OrdinalIgnoreCase) &&
             !diagnostic.Contains(privatePhoneShaPrefix, StringComparison.OrdinalIgnoreCase),
            "Diagnostics must not expose non-whitelisted candidate content.");
        True(!diagnostic.Contains("\"value\"", StringComparison.OrdinalIgnoreCase),
            "Diagnostics must not expose ValuePattern content.");

        using var document = JsonDocument.Parse(diagnostic);
        var root = document.RootElement;
        Equal(12, root.GetProperty("postFailureExactCandidateCount").GetInt32(),
            "Diagnostics must retain the exact post-failure match count.");
        Equal(UiaSafeDiagnosticFormatter.CandidateLimit,
            root.GetProperty("reportedCandidateCount").GetInt32(),
            "Diagnostics must report no more than the candidate cap.");
        True(root.GetProperty("candidatesTruncated").GetBoolean(),
            "Diagnostics must disclose structural truncation.");
        var reported = root.GetProperty("candidates");
        Equal(UiaSafeDiagnosticFormatter.CandidateLimit, reported.GetArrayLength(),
            "The serialized candidates must obey the hard cap.");

        var explicitlySafe = reported[0];
        Equal("Settings", explicitlySafe.GetProperty("name").GetString(),
            "Only explicitly whitelisted names may remain plaintext.");
        Equal("known-id", explicitlySafe.GetProperty("automationId").GetString(),
            "Only explicitly whitelisted automation ids may remain plaintext.");
        Equal("known-class", explicitlySafe.GetProperty("className").GetString(),
            "Only explicitly whitelisted classes may remain plaintext.");
        Equal("button", explicitlySafe.GetProperty("type").GetString(),
            "Known structural control types may remain plaintext.");
        Equal("dialog", explicitlySafe.GetProperty("ariaRole").GetString(),
            "Known structural ARIA roles may remain plaintext.");
        var safeActions = explicitlySafe.GetProperty("actions")
            .EnumerateArray().Select(item => item.GetString()).ToArray();
        True(safeActions.SequenceEqual(["invoke", "setValue"], StringComparer.Ordinal),
            "Only known actions may be retained, de-duplicated, and sorted.");

        var redacted = reported[1];
        foreach (var property in new[] { "name", "automationId", "className", "type", "ariaRole" })
        {
            Equal(UiaSafeDiagnosticFormatter.Redacted, redacted.GetProperty(property).GetString(),
                $"Non-whitelisted {property} must use one non-correlating redaction marker.");
        }
        Equal(0, redacted.GetProperty("actions").GetArrayLength(),
            "Unknown actions must be omitted instead of fingerprinted.");

        _ = Throws<ArgumentNullException>(() => UiaSafeDiagnosticFormatter.Format(
            new UiaSafeLocatorConstraints("settings.open", null!, [], []),
            "element_not_found", 0, []));
        _ = Throws<ArgumentException>(() => UiaSafeDiagnosticFormatter.Format(
            new UiaSafeLocatorConstraints(
                "settings.open", [@"C:\Users\private\label.txt"], [], []),
            "element_not_found", 0, []));
    }
}
