export function safeArtifactPath(value: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return value;
}
