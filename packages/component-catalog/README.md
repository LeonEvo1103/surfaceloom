# `@surfaceloom/component-catalog`

Machine-readable component contracts shared by test authors and development
agents. The catalog contains data manifests rather than one empty class per UI
pattern. Each manifest declares platforms, driver capabilities, semantic locator
ownership, actions, assertions, deterministic fixture ids, and a policy-friendly
side-effect ceiling.

```ts
import {
  fixtureCatalog,
  listComponentManifests,
} from "@surfaceloom/component-catalog";

const safeWindowsAgentComponents = listComponentManifests({
  kind: "agent",
  platform: "windows",
  maximumSideEffectLevel: "reversible",
});

const fixtureIdsToImplement = fixtureCatalog.map(fixture => fixture.id);
```

`npm run build` also produces `dist/catalog.json` and `dist/fixtures.json` for tools
that do not execute TypeScript. The 36 component manifests cover common desktop UI, system integration,
and optional agent-specific behavior. Seven fixture manifests define the current
deterministic Agent/filesystem resources; product adapters register their executable
setup through Core's `FixtureRegistry`.
