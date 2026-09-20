import { createServer } from "node:http";
import { createLoginEngine } from "./engine.mjs";
import { FixtureError } from "./errors.mjs";
import { readJson, sendHtml, sendJson } from "./http.mjs";
import { indexPage, loginPage } from "./page.mjs";

function routeRequest(engine, request, response, pathname) {
  if (request.method === "GET" && pathname === "/") {
    sendHtml(response, indexPage);
    return true;
  }
  const login = /^\/login\/(welcome|account-menu)$/.exec(pathname);
  if (request.method === "GET" && login) {
    sendHtml(response, loginPage(login[1]));
    return true;
  }
  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { status: "ready", network: "loopback-only" });
    return true;
  }
  return false;
}

async function routeApi(engine, request, response, pathname) {
  if (request.method === "POST" && pathname === "/api/runs") {
    sendJson(response, 201, engine.createRun(await readJson(request)));
    return;
  }
  const runRoute = /^\/api\/runs\/(run-\d{6})(?:\/(faults|reset|attempts))?$/.exec(pathname);
  if (runRoute) {
    const [, runId, resource] = runRoute;
    if (request.method === "GET" && resource === undefined) {
      sendJson(response, 200, engine.getRun(runId));
      return;
    }
    if (request.method === "POST" && resource === "faults") {
      sendJson(response, 200, engine.setFaults(runId, await readJson(request)));
      return;
    }
    if (request.method === "POST" && resource === "reset") {
      const body = await readJson(request);
      if (Object.keys(body).length > 0) throw new FixtureError("INVALID_INPUT", "Reset body must be empty");
      sendJson(response, 200, engine.resetRun(runId));
      return;
    }
    if (request.method === "POST" && resource === "attempts") {
      sendJson(response, 201, engine.createAttempt(runId, await readJson(request)));
      return;
    }
    throw new FixtureError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }
  const attemptRoute = /^\/api\/runs\/(run-\d{6})\/attempts\/(run-\d{6}-attempt-\d{6})(?:\/(captcha|verify|mailbox|session|observation))?$/.exec(pathname);
  if (attemptRoute) {
    const [, runId, attemptId, resource = "observation"] = attemptRoute;
    if (request.method === "GET" && resource === "observation") {
      sendJson(response, 200, engine.getObservation(runId, attemptId));
      return;
    }
    if (request.method === "GET" && resource === "mailbox") {
      sendJson(response, 200, engine.getMailbox(runId, attemptId));
      return;
    }
    if (request.method === "GET" && resource === "session") {
      sendJson(response, 200, engine.getSession(runId, attemptId));
      return;
    }
    if (request.method === "POST" && resource === "captcha") {
      sendJson(response, 200, engine.completeCaptcha(runId, attemptId, await readJson(request)));
      return;
    }
    if (request.method === "POST" && resource === "verify") {
      sendJson(response, 200, engine.verifyCode(runId, attemptId, await readJson(request)));
      return;
    }
    throw new FixtureError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }
  throw new FixtureError("NOT_FOUND", "Route not found", 404);
}

export async function startLoginFixture() {
  const engine = createLoginEngine();
  let baseUrl;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(baseUrl).host
          || (request.headers.origin && request.headers.origin !== baseUrl)) {
        throw new FixtureError("INVALID_ORIGIN", "Only this loopback fixture origin is accepted", 403);
      }
      const { pathname } = new URL(request.url, baseUrl);
      if (!routeRequest(engine, request, response, pathname)) {
        await routeApi(engine, request, response, pathname);
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, Number.isInteger(error?.status) ? error.status : 500, {
        error: { code: error?.code ?? "INTERNAL_ERROR", message: error?.message ?? "Internal error" },
      });
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return Object.freeze({
    baseUrl,
    ...engine,
    close() {
      if (closing) return closing;
      engine.close();
      closing = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  });
}
