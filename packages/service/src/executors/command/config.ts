import path from "node:path";
import { types } from "node:util";

import { parseTestId, type TestId } from "../../ids.js";
import { readSafeArrayEnvelope, readSafeRecordEnvelope } from "../../safe-data.js";
import { exactKeys } from "../../validation.js";
import type {
  CommandExecutorOptions, CommandSpawn, ProcessTreeController, RegisteredCommand,
} from "./contracts.js";

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const optionKeys = ["commands", "allowedCwds", "allowedEnvironment"] as const;
const optionalOptionKeys = ["environment", "maxStdoutBytes", "maxStderrBytes", "terminateGraceMs",
  "forceKillWaitMs", "stdioCloseWaitMs", "processTreeWaitMs", "spawn", "processTree",
  "monotonicNow", "wallNow"] as const;
const commandKeys = ["testId", "executorId", "executable", "argv", "cwd", "inheritEnvironment",
  "timeoutMs", "exitCodes"] as const;
const defaults = Object.freeze({ maxStdoutBytes: 1_048_576, maxStderrBytes: 1_048_576,
  terminateGraceMs: 250, forceKillWaitMs: 1_000, stdioCloseWaitMs: 250, processTreeWaitMs: 1_000 });

export interface CommandConfig {
  readonly commands: ReadonlyMap<TestId, RegisteredCommand>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly terminateGraceMs: number;
  readonly forceKillWaitMs: number;
  readonly stdioCloseWaitMs: number;
  readonly processTreeWaitMs: number;
  readonly spawn?: CommandSpawn;
  readonly processTree?: ProcessTreeController;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => Date;
}

export function snapshotCommandConfig(input: CommandExecutorOptions): CommandConfig {
  const seen = new WeakSet<object>();
  const options = safeRecord(input, "CommandExecutorOptions", seen);
  exactKeys(options, "CommandExecutorOptions", optionKeys, optionalOptionKeys);
  const cwdAllowlist = new Set(readStrings(options.allowedCwds, "allowedCwds", seen, validateRelativeCwd));
  const envAllowlist = new Set(readStrings(
    options.allowedEnvironment, "allowedEnvironment", seen, validateEnvironmentName,
  ));
  const commands = new Map<TestId, RegisteredCommand>();
  for (const value of safeArray(options.commands, "commands", seen)) {
    const command = snapshotCommand(value, cwdAllowlist, envAllowlist, seen);
    if (commands.has(command.testId)) throw new TypeError(`Duplicate command for ${command.testId}.`);
    commands.set(command.testId, command);
  }
  return Object.freeze({
    commands,
    environment: snapshotEnvironment(options.environment, seen),
    maxStdoutBytes: integer(options.maxStdoutBytes, defaults.maxStdoutBytes, "maxStdoutBytes"),
    maxStderrBytes: integer(options.maxStderrBytes, defaults.maxStderrBytes, "maxStderrBytes"),
    terminateGraceMs: integer(options.terminateGraceMs, defaults.terminateGraceMs, "terminateGraceMs"),
    forceKillWaitMs: integer(options.forceKillWaitMs, defaults.forceKillWaitMs, "forceKillWaitMs"),
    stdioCloseWaitMs: integer(options.stdioCloseWaitMs, defaults.stdioCloseWaitMs, "stdioCloseWaitMs"),
    processTreeWaitMs: integer(options.processTreeWaitMs, defaults.processTreeWaitMs, "processTreeWaitMs"),
    ...optionalFunction(options, "spawn"),
    ...optionalCapability(options, "processTree"),
    ...optionalFunction(options, "monotonicNow"),
    ...optionalFunction(options, "wallNow"),
  }) as CommandConfig;
}

function snapshotCommand(
  input: unknown, cwdAllowlist: ReadonlySet<string>, envAllowlist: ReadonlySet<string>,
  seen: WeakSet<object>,
): RegisteredCommand {
  const value = safeRecord(input, "RegisteredCommand", seen);
  exactKeys(value, "RegisteredCommand", commandKeys);
  const executable = string(value.executable, "executable");
  if (!path.isAbsolute(executable)) throw new TypeError("Registered command executable must be absolute.");
  const cwd = validateRelativeCwd(value.cwd);
  if (!cwdAllowlist.has(cwd)) throw new TypeError(`Command cwd is not allowlisted: ${cwd}`);
  const inheritEnvironment = readStrings(value.inheritEnvironment, "inheritEnvironment", seen,
    (name) => {
      const valid = validateEnvironmentName(name);
      if (!envAllowlist.has(valid)) throw new TypeError(`Environment name is not allowlisted: ${valid}`);
      return valid;
    });
  const exits = safeRecord(value.exitCodes, "exitCodes", seen);
  exactKeys(exits, "exitCodes", ["passed", "failed"]);
  const passed = exitCodes(exits.passed, "passed", seen);
  const failed = exitCodes(exits.failed, "failed", seen);
  if (passed.some((code) => failed.includes(code))) {
    throw new TypeError("Passed and failed exit-code allowlists must not overlap.");
  }
  return Object.freeze({ testId: parseTestId(value.testId), executorId: string(value.executorId, "executorId"),
    executable, argv: readArgv(value.argv, seen), cwd,
    inheritEnvironment, timeoutMs: integer(value.timeoutMs, undefined, "timeoutMs"),
    exitCodes: Object.freeze({ passed, failed }) });
}

function snapshotEnvironment(input: unknown, seen: WeakSet<object>) {
  if (input === undefined) return Object.freeze({ ...process.env });
  const value = safeRecord(input, "environment", seen);
  const result: Record<string, string | undefined> = {};
  for (const [name, item] of Object.entries(value)) {
    validateEnvironmentName(name);
    if (item !== undefined && typeof item !== "string") {
      throw new TypeError(`Environment value ${name} must be a string or undefined.`);
    }
    result[name] = item;
  }
  return Object.freeze(result);
}

function safeRecord(input: unknown, label: string, seen: WeakSet<object>): Record<string, unknown> {
  if (typeof input === "object" && input !== null) {
    if (seen.has(input)) throw new TypeError(`${label} reuses a mutable configuration object.`);
    seen.add(input);
  }
  return readSafeRecordEnvelope(input, label);
}

function safeArray(input: unknown, label: string, seen: WeakSet<object>): readonly unknown[] {
  if (typeof input === "object" && input !== null) {
    if (seen.has(input)) throw new TypeError(`${label} reuses a mutable configuration array.`);
    seen.add(input);
  }
  return readSafeArrayEnvelope(input, label);
}

function readStrings(
  input: unknown, label: string, seen: WeakSet<object>, validate: (value: unknown) => string,
): readonly string[] {
  const result = safeArray(input, label, seen).map(validate);
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates.`);
  return Object.freeze(result);
}

function readArgv(input: unknown, seen: WeakSet<object>): readonly string[] {
  const result = safeArray(input, "argv", seen).map((value, index) => {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError(`argv[${index}] must be a string without NUL.`);
    }
    return value;
  });
  return Object.freeze(result);
}

function validateRelativeCwd(value: unknown): string {
  const valid = string(value, "cwd");
  if (path.isAbsolute(valid)) throw new TypeError("Command cwd must be relative.");
  const normalized = path.normalize(valid);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new TypeError("Command cwd must stay inside the workspace.");
  }
  return normalized;
}

function validateEnvironmentName(value: unknown): string {
  if (typeof value !== "string" || !environmentName.test(value)) {
    throw new TypeError(`Invalid environment name: ${String(value)}`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL.`);
  }
  return value;
}

function integer(value: unknown, fallback: number | undefined, label: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || (actual as number) < 0 || (actual as number) > 2_147_483_647) {
    throw new TypeError(`${label} must be a bounded non-negative integer.`);
  }
  return actual as number;
}

function exitCodes(input: unknown, label: string, seen: WeakSet<object>): readonly number[] {
  const values = safeArray(input, `${label} exitCodes`, seen);
  if (values.some((item) => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 255)) {
    throw new TypeError(`${label} exit codes must be integers from 0 through 255.`);
  }
  if (new Set(values).size !== values.length) throw new TypeError(`${label} exit codes must be unique.`);
  return Object.freeze(values as number[]);
}

function optionalFunction(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const item = value[key];
  if (item === undefined) return {};
  if (typeof item !== "function" || types.isProxy(item)) {
    throw new TypeError(`${key} must be a non-Proxy function.`);
  }
  return { [key]: item };
}

function optionalCapability(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const item = value[key];
  if (item === undefined) return {};
  if (typeof item !== "object" || item === null || types.isProxy(item)) {
    throw new TypeError(`${key} must be a non-Proxy object.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(item, "launch");
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function" ||
    types.isProxy(descriptor.value)) {
    throw new TypeError(`${key}.launch must be an own non-Proxy data function.`);
  }
  const launch = descriptor.value as ProcessTreeController["launch"];
  return { [key]: Object.freeze({ launch: (...args: Parameters<typeof launch>) => launch(...args) }) };
}
