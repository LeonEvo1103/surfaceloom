export const desktopCapabilities = [
  "app.launch",
  "app.attach",
  "app.quit",
  "app.terminate",
  "ui.inspect",
  "ui.invoke",
  "ui.set-value",
  "ui.wait",
  "window.inspect",
  "window.manage",
  "menu.invoke",
  "keyboard.inject",
  "pointer.inject",
  "clipboard.read",
  "clipboard.write",
  "drag-drop.perform",
  "screenshot.capture",
  "browser.navigate",
  "browser.dom.inspect",
  "browser.dom.invoke",
  "browser.trace",
  "browser.network.observe",
  "browser.console.observe",
  "browser.network.proxy",
  "browser.storage.export",
  "system.open-save-panel",
  "system.permission.inspect",
  "system.notification.inspect",
  "system.status-area.inspect",
  "system.elevation.observe",
] as const;

export type DesktopCapability = (typeof desktopCapabilities)[number];

export function hasCapability(
  available: readonly DesktopCapability[],
  required: DesktopCapability,
): boolean {
  return available.includes(required);
}

export function missingCapabilities(
  available: readonly DesktopCapability[],
  required: readonly DesktopCapability[],
): DesktopCapability[] {
  return required.filter((capability) => !available.includes(capability));
}

/** Capabilities a browser-backed web run needs. A curated view over the single registry. */
export const webCapabilities = [
  "browser.navigate",
  "browser.dom.inspect",
  "browser.dom.invoke",
  "browser.trace",
  "browser.network.observe",
  "browser.console.observe",
  "browser.network.proxy",
  "browser.storage.export",
  "screenshot.capture",
] as const satisfies readonly DesktopCapability[];

export type WebCapability = (typeof webCapabilities)[number];
