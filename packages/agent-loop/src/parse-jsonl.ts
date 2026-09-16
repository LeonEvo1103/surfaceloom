import { isRecord } from "./sanitize.js";

export interface ParsedJSONLines {
  readonly records: readonly Record<string, unknown>[];
  readonly invalidLines: number;
  readonly truncated: boolean;
}

export function parseJSONLines(input: string, maximumRecords: number): ParsedJSONLines {
  const records: Record<string, unknown>[] = [];
  let invalidLines = 0;
  let attemptedLines = 0;
  let cursor = 0;
  while (cursor < input.length && attemptedLines < maximumRecords) {
    const newline = input.indexOf("\n", cursor);
    const end = newline === -1 ? input.length : newline;
    const line = input.slice(cursor, end).trim();
    cursor = newline === -1 ? input.length : newline + 1;
    if (line === "") continue;
    attemptedLines += 1;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return Object.freeze({ records: Object.freeze(records), invalidLines, truncated: cursor < input.length });
}
