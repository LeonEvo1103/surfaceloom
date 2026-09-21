import { createHash } from "node:crypto";

import type { ExecuteRequest } from "./execution.js";
import { cloneSafeData } from "./safe-data.js";

export function fingerprintExecuteRequest(request: Readonly<ExecuteRequest>): string {
  const { runId: _runId, ...stable } = request;
  return createHash("sha256").update(stableStringify(cloneSafeData(stable))).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
