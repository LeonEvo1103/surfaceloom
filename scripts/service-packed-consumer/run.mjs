import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "surfaceloom-packed-consumer-"));
const packDirectory = path.join(temporaryRoot, "packs");
const consumerDirectory = path.join(temporaryRoot, "consumer");
const packages = ["core", "llm-judge", "reporter", "test", "service"];

try {
  await mkdir(packDirectory);
  await mkdir(consumerDirectory);
  await run("npm", ["--prefix", path.join(repositoryRoot, "packages/service"), "run", "build"],
    repositoryRoot);
  const dependencies = { "@modelcontextprotocol/client": "2.0.0" };
  for (const packageName of packages) {
    const packageDirectory = path.join(repositoryRoot, "packages", packageName);
    await run("npm", ["pack", "--silent", "--pack-destination", packDirectory], packageDirectory);
    const archive = (await readdir(packDirectory)).find((name) =>
      name.startsWith(`surfaceloom-${packageName}-`) && name.endsWith(".tgz"));
    if (archive === undefined) throw new Error(`npm pack did not create ${packageName}.`);
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
    dependencies[manifest.name] = `file:../packs/${archive}`;
  }
  await cp(path.join(scriptDirectory, "consumer"), consumerDirectory, { recursive: true });
  await writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
    name: "surfaceloom-external-consumer-conformance",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
  }, null, 2)}\n`, "utf8");
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerDirectory);
  await run(process.execPath, ["--test", "mcp-flow.test.mjs", "crash-recovery.test.mjs"],
    consumerDirectory, {
      SURFACELOOM_CONSUMER_ROOT: consumerDirectory,
      SURFACELOOM_REPOSITORY_ROOT: repositoryRoot,
    });
  process.stdout.write("SurfaceLoom packed-consumer conformance passed.\n");
} catch (error) {
  process.stderr.write(`Packed-consumer conformance failed in: ${temporaryRoot}\n`);
  throw error;
} finally {
  if (process.env.SURFACELOOM_KEEP_PACKED_CONSUMER !== "1") {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function run(executable, args, cwd, environment = {}) {
  const result = await execute(executable, args, {
    cwd,
    env: { ...process.env, ...environment },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
}
