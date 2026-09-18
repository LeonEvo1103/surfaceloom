import path from "node:path";

import { runShowcase } from "./run.mjs";

try {
  const outputRoot = process.argv[2] === undefined ? undefined : path.resolve(process.argv[2]);
  const result = await runShowcase({ outputRoot });
  const summary = result.bundle.report.summary;
  process.stdout.write([
    `M1 report: ${result.bundle.reportPath}`,
    `HTML: ${result.bundle.htmlPath}`,
    `AI review: ${result.bundle.aiReviewPath}`,
    `Cases: ${summary.discovered}; passed=${summary.passed}; failed=${summary.failed}`,
    `Status: ${result.bundle.report.status} (expected showcase exit: 1)`,
    "",
  ].join("\n"));
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`SurfaceLoom M1 showcase infrastructure failure: ${safe(error)}\n`);
  process.exitCode = 2;
}

function safe(error) {
  return error instanceof Error && error.message ? error.message : "Unknown infrastructure failure.";
}
