import path from "node:path";
import { types } from "node:util";
import { maxWireMessageBytes } from "../constants.js";
import { NodeProcessTransportError, type NodeProcessTransportOptions } from "./types.js";

export interface NodeProcessConfig {
  readonly executable: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly maxFrameBytes: number;
  readonly maxOutstandingWriteBytes: number;
  readonly maxStderrBytes: number;
  readonly closeGraceMs: number;
  readonly startupTimeoutMs: number;
  readonly writeTimeoutMs: number;
  readonly forceCloseMs: number;
}

const fail = (message: string): never => {
  throw new NodeProcessTransportError("invalid_options", message);
};

function text(value: unknown, name: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${name} must be a string.`);
  if ((value as string).includes("\0")) fail(`${name} must not contain NUL.`);
  return value as string;
}

function plainStringArray(value: unknown, name: string): readonly string[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail(`${name} must be a plain array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) fail(`${name} must be a dense data array.`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))) {
      fail(`${name} must not have extra properties.`);
    }
  }
  return Object.freeze(value.map((item, index) => text(item, `${name}[${index}]`)));
}

function plainEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return Object.create(null) as Record<string, string>;
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return fail("env must be a plain data object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("env must be a plain data object.");
  const result = Object.create(null) as Record<string, string>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail("env must not contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail("env must contain only enumerable data properties.");
    }
    text(key, "env key", false);
    if (key.includes("=")) fail("env keys must not contain '='.");
    result[key] = text(descriptor.value, `env.${key}`);
  }
  return result;
}

function positiveInteger(value: unknown, fallback: number, name: string, allowZero = false): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)
    || resolved < (allowZero ? 0 : 1)) fail(`${name} is out of range.`);
  return resolved as number;
}

function timeoutInteger(value: unknown, fallback: number, name: string): number {
  const resolved = positiveInteger(value, fallback, name, true);
  if (resolved > 2_147_483_647) fail(`${name} is out of range.`);
  return resolved;
}

export function snapshotNodeProcessOptions(options: NodeProcessTransportOptions,
  platform: NodeJS.Platform = process.platform): NodeProcessConfig {
  if (typeof options !== "object" || options === null || types.isProxy(options)) {
    return fail("options must be a plain data object.");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) return fail("options must be a plain data object.");
  const descriptors = Object.getOwnPropertyDescriptors(options) as Record<string, PropertyDescriptor>;
  const allowed = new Set(["executable", "cwd", "argv", "env", "inheritEnvAllowlist", "maxFrameBytes",
    "maxOutstandingWriteBytes", "maxStderrBytes", "closeGraceMs", "startupTimeoutMs", "writeTimeoutMs",
    "forceCloseMs"]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("options contains an unknown property.");
    const stringKey = key as string;
    if (!allowed.has(stringKey)) fail("options contains an unknown property.");
    const descriptor = descriptors[stringKey];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail("options must contain only enumerable data properties.");
    }
  }
  const option = (key: string): unknown => descriptors[key]?.value;
  const executable = text(option("executable"), "executable", false);
  const cwd = text(option("cwd"), "cwd", false);
  if (!path.isAbsolute(executable) || !path.isAbsolute(cwd)) fail("executable and cwd must be absolute paths.");
  if (/\.(?:cmd|bat)$/iu.test(executable)) fail(".cmd and .bat launchers are not supported.");
  const argv = plainStringArray(option("argv") ?? [], "argv");
  const env = plainEnvironment(option("env"));
  const allowlist = plainStringArray(option("inheritEnvAllowlist") ?? [], "inheritEnvAllowlist");
  const names = new Map<string, string>();
  const add = (key: string, value: string): void => {
    const identity = platform === "win32" ? key.toLocaleLowerCase("en-US") : key;
    const previous = names.get(identity);
    if (previous !== undefined) fail(`environment keys '${previous}' and '${key}' collide.`);
    names.set(identity, key);
    env[key] = value;
  };
  const explicit = { ...env };
  for (const key of Object.keys(env)) delete env[key];
  for (const [key, value] of Object.entries(explicit)) add(key, value);
  for (const key of allowlist) {
    text(key, "inheritEnvAllowlist entry", false);
    if (key.includes("=")) fail("environment keys must not contain '='.");
    const value = process.env[key];
    if (value !== undefined) add(key, text(value, `process.env.${key}`));
  }
  return Object.freeze({ executable, cwd, argv, env: Object.freeze({ ...env }),
    maxFrameBytes: positiveInteger(option("maxFrameBytes"), maxWireMessageBytes, "maxFrameBytes"),
    maxOutstandingWriteBytes: positiveInteger(option("maxOutstandingWriteBytes"),
      maxWireMessageBytes * 4, "maxOutstandingWriteBytes"),
    maxStderrBytes: positiveInteger(option("maxStderrBytes"), 65_536, "maxStderrBytes", true),
    closeGraceMs: timeoutInteger(option("closeGraceMs"), 500, "closeGraceMs"),
    startupTimeoutMs: timeoutInteger(option("startupTimeoutMs"), 5_000, "startupTimeoutMs"),
    writeTimeoutMs: timeoutInteger(option("writeTimeoutMs"), 5_000, "writeTimeoutMs"),
    forceCloseMs: timeoutInteger(option("forceCloseMs"), 5_000, "forceCloseMs") });
}
