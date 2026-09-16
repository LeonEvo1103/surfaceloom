import type { TestErrorSummary } from "@surfaceloom/reporter";

/** Core places the original setup error first in setup/rollback AggregateErrors. */
export function errorSummary(category: string, error: unknown): TestErrorSummary {
  return Object.freeze({ category, message: messages(error)[0] ?? "Unknown failure." });
}

export function errorDiagnostic(category: string, error: unknown): string {
  return JSON.stringify({ category, errors: messages(error) });
}

function messages(error: unknown, seen = new Set<unknown>(), depth = 0,
  budget = { remaining: 1000 }): string[] {
  if (budget.remaining-- <= 0) return ["Error details exceeded the diagnostic limit."];
  if (depth >= 32) return ["Error nesting exceeded the diagnostic limit."];
  try {
    // Even instanceof can throw when a thrown value is a hostile/revoked Proxy.
    if (error instanceof AggregateError) {
      if (seen.has(error)) return ["Circular AggregateError."];
      const ancestry = new Set([...seen, error]);
      let causes: unknown;
      try { causes = error.errors; } catch {
        return [safeErrorText(error), "AggregateError causes could not be read."];
      }
      if (!Array.isArray(causes)) {
        return [safeErrorText(error), "AggregateError causes were not an array."];
      }
      const result: string[] = [];
      try {
        const count = causes.length;
        for (let index = 0; index < count; index += 1) {
          if (budget.remaining <= 0) {
            result.push("Additional AggregateError causes exceeded the diagnostic limit.");
            break;
          }
          try { result.push(...messages(causes[index], ancestry, depth + 1, budget)); } catch {
            budget.remaining -= 1;
            result.push("An AggregateError cause could not be read.");
          }
        }
      } catch { result.push("AggregateError causes could not be inspected."); }
      return result.length === 0 ? [safeErrorText(error)] : result;
    }
    if (error instanceof Error) return [safeErrorText(error)];
    return [String(error).trim() || "An empty value was thrown."];
  } catch {
    return ["An error value could not be inspected."];
  }
}

function safeErrorText(error: Error): string {
  for (const field of ["message", "name"] as const) {
    try {
      const value: unknown = error[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    } catch { /* A broken getter must not interrupt cleanup or hide the failure. */ }
  }
  return "Error details could not be read.";
}
