import {
  PlaywrightBrowserBackend, defineDomLocator,
  type BrowserSession, type BrowserObservationHandle, type BrowserArtifact,
  type DomElementState,
} from "@surfaceloom/browser-playwright";

export async function consume(session: BrowserSession): Promise<BrowserArtifact> {
  const handle: BrowserObservationHandle = session.observe({ limit: 2 });
  const state: DomElementState = await session.elementState(defineDomLocator({
    key: "fixture.action", kind: "testId", value: "action",
  }));
  if (state.present) handle.stop();
  return session.saveStorageState("/synthetic/state.json", { indexedDB: true });
}
export const backend = new PlaywrightBrowserBackend();
