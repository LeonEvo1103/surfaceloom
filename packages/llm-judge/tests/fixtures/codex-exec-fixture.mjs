import { readFile, writeFile } from "node:fs/promises";

const fixtureArgs = process.argv.slice(2);
const modeIndex = fixtureArgs.indexOf("--fixture-mode");
const probeIndex = fixtureArgs.indexOf("--fixture-probe");
const mode = fixtureArgs[modeIndex + 1];
const probePath = fixtureArgs[probeIndex + 1];
const codexArgs = fixtureArgs.slice(fixtureArgs.indexOf("exec"));

const valueAfter = (flag) => codexArgs[codexArgs.indexOf(flag) + 1];

if (mode === "hang") {
  await writeFile(probePath, JSON.stringify({ pid: process.pid, cwd: process.cwd() }), "utf8");
  setInterval(() => undefined, 1_000);
} else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk.toString();
  const schemaPath = valueAfter("--output-schema");
  const outputPath = valueAfter("--output-last-message");
  const imageArgument = codexArgs.includes("--image") ? valueAfter("--image") : "";
  const imagePaths = imageArgument === "" ? [] : imageArgument.split(",");
  const images = await Promise.all(imagePaths.map(async (path) => ({
    path,
    dataBase64: (await readFile(path)).toString("base64"),
  })));
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  await writeFile(probePath, JSON.stringify({ codexArgs, prompt, images, schema }), "utf8");
  await writeFile(outputPath, JSON.stringify({
    status: "classified",
    label: "sign-up",
    confidence: 0.9,
    reason: null,
    reasons: ["The current evidence shows the registration route."],
    evidenceRefs: ["ev-1"],
    observedFacts: [{
      kind: "observed",
      scope: "ui",
      statement: "The heading says Create account.",
      evidenceRefs: ["ev-1"],
    }],
    hypotheses: [],
  }), "utf8");
}
