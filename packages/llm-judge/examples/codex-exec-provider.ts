import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindStructuredDecision,
  judgeInstructions,
  judgeOutputSchema,
  judgePrompt,
  type JudgeProvider,
  type JudgeProviderContext,
  JudgeProviderError,
  type JudgeRequest,
} from "../src/index.js";

type SpawnCodex = (
  executable: string,
  argv: readonly string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcessWithoutNullStreams;

export interface CodexExecExampleOptions {
  /** Pin the actual model so report metadata does not guess what local config selected. */
  readonly model: string;
  readonly binary?: string;
  /** Useful for launchers such as `node fixture.mjs`; normally empty for the real Codex CLI. */
  readonly launcherArgs?: readonly string[];
  readonly terminateGraceMs?: number;
  readonly spawn?: SpawnCodex;
}

/**
 * Optional example binding, not a SurfaceLoom core provider type. It shows how any local Agent can
 * implement JudgeProvider while keeping its CLI-specific lifecycle outside the router.
 */
export function createCodexExecExampleProvider(options: CodexExecExampleOptions): JudgeProvider {
  const model = options.model.trim();
  if (model === "") throw new TypeError("Codex example model must not be empty.");
  const binary = (options.binary ?? "codex").trim();
  if (binary === "") throw new TypeError("Codex example binary must not be empty.");
  const launcherArgs = [...(options.launcherArgs ?? [])];
  const terminateGraceMs = options.terminateGraceMs ?? 1_000;
  if (!Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 0) {
    throw new TypeError("Codex example terminateGraceMs must be a non-negative integer.");
  }
  const spawnCodex = options.spawn ?? ((executable, argv, spawnOptions) =>
    nodeSpawn(executable, [...argv], spawnOptions) as ChildProcessWithoutNullStreams);

  return Object.freeze({
    name: "codex-exec-example",
    judge: async (request: JudgeRequest, context: JudgeProviderContext): Promise<unknown> => {
      const startedAt = Date.now();
      const metadata = () => ({
        provider: "codex-exec-example",
        model,
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
      const root = await mkdtemp(join(tmpdir(), "surfaceloom-codex-judge-"));
      try {
        const schemaPath = join(root, "judge-output.schema.json");
        const outputPath = join(root, "judge-output.json");
        await writeFile(schemaPath, JSON.stringify(judgeOutputSchema(request)), "utf8");
        const imagePaths = await materializeImages(root, request);
        const argv = [
          ...launcherArgs,
          "exec",
          "--ephemeral",
          "--sandbox", "read-only",
          "--skip-git-repo-check",
          "--ignore-rules",
          "--color", "never",
          "--model", model,
          "--output-schema", schemaPath,
          "--output-last-message", outputPath,
          "--cd", root,
          ...(imagePaths.length === 0 ? [] : ["--image", imagePaths.join(",")]),
          "-",
        ];
        const child = spawnCodex(binary, argv, {
          cwd: root,
          env: process.env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdout.resume();
        child.stderr.resume();
        child.stdin.on("error", () => undefined);
        child.stdin.end(`${judgeInstructions()}\n\n${judgePrompt(request)}`);
        const exit = await waitForOwnedChild(child, context, terminateGraceMs);
        if (exit.code !== 0 || exit.signal !== null) {
          throw new JudgeProviderError("provider", "Codex Judge process failed", false, metadata());
        }
        const output = await readFile(outputPath, "utf8");
        return bindStructuredDecision(output, metadata());
      } catch (error) {
        if (error instanceof JudgeProviderError) throw error;
        throw new JudgeProviderError("provider", "Codex Judge invocation failed", false, metadata());
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  });
}

async function materializeImages(root: string, request: JudgeRequest): Promise<string[]> {
  const paths: string[] = [];
  for (const evidence of request.evidence) {
    if (evidence.kind !== "image") continue;
    const extension = evidence.mediaType === "image/jpeg" ? "jpg"
      : evidence.mediaType === "image/webp" ? "webp" : "png";
    const path = join(root, `${evidence.evidenceId}.${extension}`);
    await writeFile(path, Buffer.from(evidence.dataBase64, "base64"));
    paths.push(path);
  }
  return paths;
}

function waitForOwnedChild(
  child: ChildProcessWithoutNullStreams,
  context: JudgeProviderContext,
  terminateGraceMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, context.deadlineAt - Date.now());
    const stop = () => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), terminateGraceMs);
    };
    const deadlineTimer = setTimeout(stop, remaining);
    context.signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      clearTimeout(deadlineTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      context.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadlineTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      context.signal.removeEventListener("abort", stop);
      resolve({ code, signal });
    });
    if (context.signal.aborted || remaining === 0) stop();
  });
}
