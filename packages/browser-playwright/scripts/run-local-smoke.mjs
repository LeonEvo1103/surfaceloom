import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = new URL("../../../scripts/run-typescript-package-tests.mjs", import.meta.url);
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(runner)], {
    stdio: "inherit",
    env: { ...process.env, SURFACELOOM_BROWSER_SMOKE: "1" },
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) reject(new Error(`Local browser smoke stopped by ${signal}.`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
