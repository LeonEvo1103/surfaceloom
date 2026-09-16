# Playwright browser backend

`@surfaceloom/browser-playwright` is an optional DOM automation backend. It
keeps browser selectors and Playwright lifecycle objects outside
`@surfaceloom/core`, while desktop adapters continue to own native windows,
menus, permission prompts, and file dialogs through AX/UIA.

The package depends on `playwright-core`, so installing the ordinary Core package
does not download browsers or add a Playwright runtime. Install a browser explicitly
or select an installed browser channel:

```bash
npx playwright-core install chromium
```

Run the repeatable local system-Chrome cases with:

```bash
npm run test:local
```

The local lane covers real navigation, form interaction, semantic locators, strict
matching, and session cleanup. The default test lane also combines Core native
guarded actions with browser DOM actions to detect dispatch or naming collisions.

```ts
import {
  PlaywrightBrowserBackend,
  defineDomLocator,
} from "@surfaceloom/browser-playwright";

const backend = new PlaywrightBrowserBackend();
const browser = await backend.launch({
  engine: "chromium",
  headless: true,
  context: {
    baseURL: "https://example.test",
    locale: "zh-CN",
    proxy: { server: "http://proxy.example.test:8080" },
  },
});

try {
  await browser.navigate("/login");
  await browser.fill(
    defineDomLocator({ key: "login.email", kind: "label", text: "邮箱" }),
    "fixture@example.test",
  );
  await browser.click({
    key: "login.submit",
    kind: "role",
    role: "button",
    name: "登录",
  });
} finally {
  await browser.close();
}
```

Role, label, text, and test-id locators are preferred. CSS is an explicit adapter
escape hatch. Actions fail when a target resolves to more than one element.

Screenshot and trace results are marked `sensitive: true`; their files are restricted
to `0o600` after capture on POSIX. The shared capture helper reports permission
failures explicitly. Windows protection depends on the destination's inherited NTFS
ACLs; a POSIX mode does not establish an owner-only Windows ACL. A runner can translate
them to Reporter `SourceArtifact` records and let the existing evidence policy decide
whether to retain them. The backend never attaches to or closes a user-owned browser;
its current launch API owns every browser process that it creates.

Proxy settings are scoped to the owned browser context. Supported servers use
`http`, `https`, or `socks5` and contain only scheme, host, and port. HTTP(S)
credentials must be supplied through the separate
`username` and `password` fields so they are not embedded in a URL or echoed by
validation diagnostics; Playwright does not support authenticated SOCKS5 proxies.
When any proxy is configured, raw Playwright launch errors are not retained as a
public `cause`, because they may echo proxy details. `browserCapabilities` declares both proxy and screenshot
support for callers that gate features through the public capability contract.

`session.elementState(locator)` returns presence, visibility and enablement from
one resolved node. Missing targets return `present: false`; ambiguous targets and
automation failures throw. Reads are sequential, not an atomic DOM snapshot.
`clickable` does not guarantee stability or absence of an overlay.

`session.observe({ limit: 5000 })` subscribes to console, page errors and request
lifecycle signals. Its idempotent `stop()` returns `{ observations, dropped }`.
Request IDs distinguish concurrent requests to one URL, and bounded retention makes
lost entries explicit. Closing the owned session stops all subscriptions. Raw
observations are sensitive; callers own redaction, retention and verdict policies.

`session.saveStorageState(absoluteJsonPath, { indexedDB: true })` exports cookies
and localStorage, with IndexedDB only on explicit opt-in. It does not export
sessionStorage. The destination is replaced atomically from an exclusive owner-only
partial file; a pre-existing partial is not overwritten. Reuse the result through
`context.storageStatePath`. These files are credential-equivalent and must not be
committed or treated as ordinary public evidence.

This package remains private to npm publication. Consumers can check out a pinned
framework commit, run `npm ci && npm run build && npm pack` in this package, and
install the resulting archive. No npm registry publication is implied.
`npm run test:packed` verifies an isolated consumer without source-directory links.
Contribution attribution is preserved in the repository commit metadata.
