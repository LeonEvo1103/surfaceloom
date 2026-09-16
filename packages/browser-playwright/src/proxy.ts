import type { BrowserContextOptions } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";

const proxyProtocols: readonly string[] = ["http:", "https:", "socks5:"];
const controlCharacters = /[\u0000-\u001f\u007f]/u;

/** Snapshot and validate proxy fields without echoing credential-bearing values. */
export function browserProxyOptions(
  options: BrowserContextOptions,
): Record<string, unknown> | undefined {
  let requestedProxy: unknown;
  try {
    requestedProxy = options.proxy;
  } catch {
    throw invalidProxyOption("proxy must be readable");
  }
  if (requestedProxy === undefined) return undefined;
  if (typeof requestedProxy !== "object" || requestedProxy === null) {
    throw invalidProxyOption("proxy must be an object when provided");
  }

  let server: unknown;
  let bypass: unknown;
  let username: unknown;
  let password: unknown;
  try {
    ({ server, bypass, username, password } = requestedProxy as Record<string, unknown>);
  } catch {
    throw invalidProxyOption("proxy fields must be readable");
  }
  if (typeof server !== "string" || server.trim().length === 0) {
    throw invalidProxyOption("proxy.server must be a non-empty string");
  }
  if (controlCharacters.test(server)) {
    throw invalidProxyOption("proxy.server must not contain control characters");
  }
  if (server !== server.trim()) {
    throw invalidProxyOption("proxy.server must not have leading or trailing whitespace");
  }

  const parsed = parseProxyURL(server);
  if (!proxyProtocols.includes(parsed.protocol)) {
    throw invalidProxyOption("proxy.server must use http, https, or socks5");
  }
  if (parsed.hostname.length === 0) {
    throw invalidProxyOption("proxy.server must include a host");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw invalidProxyOption(
      "proxy.server must not embed credentials; use proxy.username and proxy.password",
    );
  }
  if (!hasAuthorityOnlySyntax(server, parsed.protocol)) {
    throw invalidProxyOption("proxy.server must contain only scheme, host, and port");
  }
  if ((username === undefined) !== (password === undefined)) {
    throw invalidProxyOption("proxy.username and proxy.password must be provided together");
  }
  requireOptionalText(bypass, "proxy.bypass");
  requireOptionalText(username, "proxy.username");
  requireOptionalText(password, "proxy.password");
  if (parsed.protocol === "socks5:" && username !== undefined) {
    throw invalidProxyOption("socks5 proxy authentication is not supported");
  }
  return {
    server,
    ...(bypass === undefined ? {} : { bypass }),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

function hasAuthorityOnlySyntax(server: string, protocol: string): boolean {
  const prefix = `${protocol}//`;
  if (!server.startsWith(prefix)) return false;
  const authority = server.slice(prefix.length);
  return authority.length > 0 && !/[\\/?#]/u.test(authority);
}

function parseProxyURL(server: string): URL {
  try {
    return new URL(server);
  } catch {
    throw invalidProxyOption("proxy.server must be a parsable absolute URL");
  }
}

function requireOptionalText(
  value: unknown,
  name: string,
): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    throw invalidProxyOption(`${name} must be a non-empty string`);
  }
  if (typeof value === "string" && controlCharacters.test(value)) {
    throw invalidProxyOption(`${name} must not contain control characters`);
  }
}

function invalidProxyOption(detail: string): BrowserAutomationError {
  return new BrowserAutomationError(
    "invalidArgument",
    `Invalid browser launch options: ${detail}.`,
  );
}
