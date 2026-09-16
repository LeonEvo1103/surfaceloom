import { access } from "node:fs/promises";

const platformCandidates = Object.freeze({
  darwin: Object.freeze([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]),
  linux: Object.freeze([
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]),
  win32: Object.freeze([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ]),
});

async function isExecutable(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an explicitly selected or system-installed Chromium browser. Missing
 * browser support is an E2E failure: the showcase never turns itself into a skip.
 */
export async function resolveBrowserLaunchOptions(environment = process.env) {
  const selected = environment.SURFACELOOM_BROWSER_EXECUTABLE?.trim();
  if (selected) {
    if (!await isExecutable(selected)) {
      throw new Error("SURFACELOOM_BROWSER_EXECUTABLE does not point to an accessible browser.");
    }
    return Object.freeze({ engine: "chromium", headless: true, executablePath: selected });
  }

  for (const candidate of platformCandidates[process.platform] ?? []) {
    if (await isExecutable(candidate)) {
      return Object.freeze({ engine: "chromium", headless: true, executablePath: candidate });
    }
  }
  throw new Error(
    "No system Chromium browser was found. Set SURFACELOOM_BROWSER_EXECUTABLE to run the required E2E suite.",
  );
}
