import { createServer } from "node:http";
import { createRunEngine, FixtureError } from "./engine.mjs";
import { approvalPage } from "./page.mjs";

async function readBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new FixtureError("INVALID_CONTENT_TYPE", "Expected application/json", 415);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new FixtureError("BODY_TOO_LARGE", "Request body exceeds 4096 bytes", 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected object");
    return body;
  } catch {
    throw new FixtureError("INVALID_JSON", "Expected a JSON object");
  }
}

export async function startReferenceAgent() {
  const engine = createRunEngine();
  let baseUrl;
  const server = createServer(async (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(baseUrl).host
          || (request.headers.origin && request.headers.origin !== baseUrl)) {
        throw new FixtureError("INVALID_ORIGIN", "Only this loopback fixture origin is accepted", 403);
      }
      const { pathname } = new URL(request.url, baseUrl);
      if (request.method === "GET" && pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(approvalPage);
      } else if (request.method === "POST" && pathname === "/api/runs") {
        json(201, engine.createRun(await readBody(request)));
      } else {
        const match = /^\/api\/runs\/(run-\d+)(?:\/(decision|ledger|effects|stop|emergency|settle|control))?$/.exec(pathname);
        if (!match) throw new FixtureError("NOT_FOUND", "Route not found", 404);
        const [, runId, resource] = match;
        if (request.method === "GET" && !resource) json(200, engine.getRun(runId));
        else if (request.method === "GET" && resource === "ledger") json(200, engine.readLedger(runId));
        else if (request.method === "GET" && resource === "effects") json(200, engine.readEffects(runId));
        else if (request.method === "POST" && resource === "decision") {
          json(200, engine.decide(runId, (await readBody(request)).decision));
        } else if (request.method === "POST" && (resource === "stop" || resource === "emergency")) {
          const body = await readBody(request);
          json(200, engine.stop(runId, { mode: resource === "emergency" ? "emergency" : body.mode }));
        } else if (request.method === "POST" && resource === "settle") {
          json(200, await engine.settle(runId, await readBody(request)));
        } else if (request.method === "POST" && resource === "control") {
          json(200, engine.control(runId, await readBody(request)));
        } else throw new FixtureError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
      }
    } catch (error) {
      const status = error instanceof FixtureError || Number.isInteger(error?.status) ? error.status : 500;
      json(status, {
        error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
      });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return Object.freeze({
    baseUrl,
    createRun: engine.createRun,
    getRun: engine.getRun,
    decide: engine.decide,
    readLedger: engine.readLedger,
    readEffects: engine.readEffects,
    stop: engine.stop,
    settle: engine.settle,
    pauseCheckpoint: engine.pauseCheckpoint,
    resumeCheckpoint: engine.resumeCheckpoint,
    failCheckpoint: engine.failCheckpoint,
    readCheckpoint: engine.readCheckpoint,
    control: engine.control,
    close(options) {
      if (closing !== undefined) return closing;
      const work = engine.close(options);
      const listener = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      closing = Promise.allSettled([work, listener]).then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      });
      return closing;
    },
  });
}
