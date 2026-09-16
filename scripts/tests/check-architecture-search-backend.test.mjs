import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { withPreparedArchitectureFixture } from "./support/architecture-fixture.mjs";

test("architecture guard fails closed when its search backend errors", async () => {
  await withPreparedArchitectureFixture(
    async (root) => {
      const toolDirectory = path.join(root, "tool-bin");
      const fakeGrep = path.join(toolDirectory, "grep");
      await mkdir(toolDirectory, { recursive: true });
      await writeFile(fakeGrep, "#!/usr/bin/env bash\nexit 2\n", "utf8");
      await chmod(fakeGrep, 0o755);
      await mkdir(path.join(root, "packages/core/src"), { recursive: true });
      await writeFile(
        path.join(root, "packages/core/src/neutral.ts"),
        "export const neutral = true;\n",
        "utf8",
      );
      return { PATH: `${toolDirectory}${path.delimiter}${process.env.PATH}` };
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /architecture search backend failed with exit status 2/);
      assert.doesNotMatch(result.stdout, /Architecture check passed/);
    },
    "grep",
  );
});
