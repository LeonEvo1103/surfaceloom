import { writeFile } from "node:fs/promises";

import { componentCatalog, fixtureCatalog } from "../dist/index.js";

const outputs = [
  ["catalog.json", componentCatalog],
  ["fixtures.json", fixtureCatalog],
];

await Promise.all(
  outputs.map(([name, data]) =>
    writeFile(
      new URL(`../dist/${name}`, import.meta.url),
      `${JSON.stringify(data, null, 2)}\n`,
      "utf8",
    ),
  ),
);
