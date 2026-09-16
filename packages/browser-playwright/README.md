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

Screenshot and trace results are marked `sensitive: true`. A runner can translate
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
