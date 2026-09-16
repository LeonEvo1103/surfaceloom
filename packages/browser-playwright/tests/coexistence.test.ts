import assert from "node:assert/strict";
import test from "node:test";

import {
  defineLocator,
  GuardedElementActions,
  type ActionabilityRequest,
  type ElementActionBackend,
  type ElementActionTarget,
  type ElementReference,
  type ResolvedElementAction,
} from "../../core/src/index.js";
import {
  defineDomLocator,
  PlaywrightBrowserBackend,
} from "../src/index.js";
import { FakeBrowserType, fakePlaywright } from "./fakes.js";

test("native guarded actions and browser DOM actions coexist without dispatch collisions", async () => {
  const nativeLocator = defineLocator({
    key: "native.save",
    role: "button",
    name: "保存窗口",
  });
  const domLocator = defineDomLocator({
    key: "web.save",
    kind: "role",
    role: "button",
    name: "保存网页",
  });
  const nativeBackend = new RecordingNativeBackend(nativeLocator);
  const nativeActions = GuardedElementActions.fromBackend(nativeBackend);
  const playwright = fakePlaywright();
  const browserType = playwright.chromium as FakeBrowserType;
  const browser = await new PlaywrightBrowserBackend(async () => playwright).launch();

  await Promise.all([
    nativeActions.invoke(nativeLocator),
    browser.click(domLocator),
  ]);

  assert.deepEqual(nativeBackend.resolvedKeys, ["native.save"]);
  assert.deepEqual(nativeBackend.performedKinds, ["invoke"]);
  assert.deepEqual(browserType.browser.context.page.resolutions, [
    "role:button:保存网页:undefined",
  ]);
  assert.equal(browserType.browser.context.page.target.calls.filter(
    (call) => call === "click"
  ).length, 1);
  await browser.close();
});

class RecordingNativeBackend implements ElementActionBackend {
  public readonly supportedActionabilityChecks = [
    "attached",
    "unique",
    "visible",
    "enabled",
    "editable",
    "focusable",
  ] as const;
  public readonly resolvedKeys: string[] = [];
  public readonly performedKinds: string[] = [];

  public constructor(private readonly locator: ReturnType<typeof defineLocator>) {}

  public async resolveActionability(
    target: ElementActionTarget,
    _request: ActionabilityRequest,
  ): Promise<ElementReference> {
    this.resolvedKeys.push("id" in target ? target.locator.key : target.key);
    return { id: "native-element", locator: this.locator };
  }

  public async performResolvedAction(action: ResolvedElementAction): Promise<void> {
    this.performedKinds.push(action.kind);
  }
}
