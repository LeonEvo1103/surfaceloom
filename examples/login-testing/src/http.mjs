import { FixtureError, requireObject } from "./errors.mjs";

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*[a-z0-9!#$%&'*+.^_`|~-]+\s*=\s*(?:[a-z0-9!#$%&'*+.^_`|~-]+|"(?:[^"\\\r\n]|\\.)*"))*$/i;

export async function readJson(request) {
  const contentType = request.headers["content-type"]?.trim();
  if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) {
    throw new FixtureError("INVALID_CONTENT_TYPE", "Expected application/json", 415);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new FixtureError("BODY_TOO_LARGE", "Body exceeds 4096 bytes", 413);
    chunks.push(chunk);
  }
  try {
    return requireObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    throw new FixtureError("INVALID_JSON", "Expected a JSON object");
  }
}

export function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}
