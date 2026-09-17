import { testPlatforms, type TestPlatform } from "@surfaceloom/core";

export interface CliArguments {
  readonly help: boolean;
  readonly config?: string;
  readonly sources: readonly string[];
  readonly platform?: TestPlatform;
  readonly output?: string;
  readonly ids: readonly string[];
  readonly filters: readonly string[];
  readonly timeoutMs?: number;
  readonly runId?: string;
  readonly title?: string;
  readonly appId?: string;
  readonly appName?: string;
}

const valueOptions = new Set([
  "--config", "--source", "--platform", "--output", "--case-id", "--filter", "--timeout-ms",
  "--run-id", "--title", "--app-id", "--app-name",
]);

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string[]>();
  const sources: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") { help = true; continue; }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals === -1 ? argument : argument.slice(0, equals);
      if (!valueOptions.has(name)) throw new Error(`Unknown option: ${name}.`);
      const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
      if (value === undefined || value.length === 0 || (equals === -1 && value.startsWith("--"))) {
        throw new Error(`Option ${name} requires a value.`);
      }
      if (equals === -1) index += 1;
      values.set(name, [...values.get(name) ?? [], value]);
      continue;
    }
    sources.push(argument);
  }
  sources.push(...all(values, "--source"));
  const platformValue = one(values, "--platform");
  const platform = platformValue === undefined ? undefined : parsePlatform(platformValue);
  const timeoutValue = one(values, "--timeout-ms");
  const timeoutMs = timeoutValue === undefined ? undefined : parseTimeout(timeoutValue);
  return Object.freeze({
    help,
    sources: Object.freeze(sources),
    ids: Object.freeze(all(values, "--case-id")),
    filters: Object.freeze(all(values, "--filter")),
    ...(one(values, "--config") === undefined ? {} : { config: one(values, "--config")! }),
    ...(platform === undefined ? {} : { platform }),
    ...(one(values, "--output") === undefined ? {} : { output: one(values, "--output")! }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(one(values, "--run-id") === undefined ? {} : { runId: one(values, "--run-id")! }),
    ...(one(values, "--title") === undefined ? {} : { title: one(values, "--title")! }),
    ...(one(values, "--app-id") === undefined ? {} : { appId: one(values, "--app-id")! }),
    ...(one(values, "--app-name") === undefined ? {} : { appName: one(values, "--app-name")! }),
  });
}

function all(values: ReadonlyMap<string, string[]>, name: string): string[] {
  return [...values.get(name) ?? []];
}

function one(values: ReadonlyMap<string, string[]>, name: string): string | undefined {
  const found = values.get(name);
  if (found !== undefined && found.length > 1 && name !== "--source") {
    throw new Error(`Option ${name} may only be specified once.`);
  }
  return found?.[0];
}

function parsePlatform(value: string): TestPlatform {
  if (!testPlatforms.includes(value as TestPlatform)) throw new Error(`Unknown platform: ${value}.`);
  return value as TestPlatform;
}

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  return timeout;
}

export const cliUsage = `Usage: sl-test [--config <path>] [--platform <web|macos|windows>] [--output <directory>] [options] [module-or-directory...]

Options:
  --config <path>       Load a defineProject() config module
  --source <path>       Add an explicit Case module or discovery directory
  --case-id <id>       Run one exact Case id (repeatable)
  --filter <text>      Match id, suite name, or Case name (repeatable, OR)
  --timeout-ms <ms>    Set the default per-Case lifecycle timeout
  --run-id <id>        Set the stable report run id
  --title <text>       Set the report title
  --app-id <id>        Set the reported app id
  --app-name <text>    Set the reported app name
  -h, --help           Show this help
`;
