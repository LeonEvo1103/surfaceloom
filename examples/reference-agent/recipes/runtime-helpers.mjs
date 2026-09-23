import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertObservationBounded,
  captureBoundedDiagnostic,
  waitForObservationBounded,
} from "@surfaceloom/test";

const readyExpectation = Object.freeze({
  kind: "value",
  expected: Object.freeze({ state: "ready" }),
  matches: (value) => value.state === "ready",
});

/** Read a JSON status file. Every invocation performs a fresh, read-only filesystem read. */
export function createFileStatusReader(filePath) {
  return async ({ signal }) => {
    const value = JSON.parse(await readFile(filePath, { encoding: "utf8", signal }));
    return { state: "available", value, evidenceIds: ["runtime.file-status"] };
  };
}

/** Read one job endpoint. Every invocation performs a fresh, read-only HTTP GET. */
export function createHttpJobStatusReader(jobUrl) {
  return async ({ signal }) => {
    const response = await fetch(jobUrl, { method: "GET", signal });
    if (!response.ok) throw new Error(`Job status read failed with HTTP ${response.status}.`);
    return {
      state: "available",
      value: await response.json(),
      evidenceIds: ["runtime.http-job-status"],
    };
  };
}

/**
 * The same bounded wait accepts either reader above (or any public ObservationReader).
 * This helper only returns observation facts; it does not create a Case verdict.
 */
export function waitForReadyStatus(reader, options) {
  return waitForObservationBounded(reader, { ...options, expectation: readyExpectation });
}

/** A throwing variant for callers that want assertion semantics. */
export function assertReadyStatus(reader, options) {
  return assertObservationBounded(reader, { ...options, expectation: readyExpectation });
}

/**
 * Capture optional diagnostics after an assertion error. Both the original error object and
 * the structured diagnostic outcome are returned, so a diagnostic failure cannot replace it.
 */
export async function assertReadyStatusWithDiagnostic(reader, diagnostic, options) {
  const { diagnosticTimeoutMs = 100, ...assertionOptions } = options;
  try {
    return Object.freeze({
      assertion: await assertReadyStatus(reader, assertionOptions),
      assertionError: null,
      diagnostic: null,
    });
  } catch (assertionError) {
    const diagnosticResult = await captureBoundedDiagnostic(
      (context) => diagnostic(assertionError, context),
      {
        timeoutMs: diagnosticTimeoutMs,
        cancellationGraceMs: assertionOptions.cancellationGraceMs,
        signal: assertionOptions.signal,
      },
    );
    return Object.freeze({ assertion: null, assertionError, diagnostic: diagnosticResult });
  }
}

/**
 * Runnable consumer recipe using a temporary file and a loopback HTTP job endpoint.
 * Fixture writes happen before observation; both readers themselves are read-only.
 */
export async function runRuntimeHelpersRecipe() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-runtime-helpers-"));
  const filePath = path.join(directory, "status.json");
  const server = createJobServer();
  let jobUrl;
  let observations;
  try {
    await writeFile(filePath, JSON.stringify({ source: "file", state: "ready" }));
    jobUrl = await listenLoopback(server);
    const options = {
      timeoutMs: 1_000,
      pollIntervalMs: 20,
      cancellationGraceMs: 100,
      criterionId: "runtime.status.ready",
    };
    const [file, httpJob] = await Promise.all([
      waitForReadyStatus(createFileStatusReader(filePath), options),
      waitForReadyStatus(createHttpJobStatusReader(jobUrl), options),
    ]);
    observations = { file, httpJob };
  } finally {
    try {
      await closeServer(server);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { ...observations, filePath, jobUrl,
    cleanup: { fileRemoved: true, serverClosed: true } };
}

function createJobServer() {
  return http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/jobs/example") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ source: "loopback-http", state: "ready" }));
  });
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}/jobs/example`);
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

if (process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await runRuntimeHelpersRecipe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // This exit code validates the recipe invocation; the helper results are not a Case verdict.
  if (result.file.status !== "passed" || result.httpJob.status !== "passed") process.exitCode = 1;
}
