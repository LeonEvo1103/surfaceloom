import { NativeBindingError } from "./contracts.js";

export function validateCleanupBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new NativeBindingError("deadline",
      "Native cleanup timeout must be a safe integer between 0 and 2147483647 milliseconds.");
  }
  return value;
}
