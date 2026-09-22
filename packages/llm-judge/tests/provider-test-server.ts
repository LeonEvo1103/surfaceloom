import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface TestRequest {
  readonly request: IncomingMessage;
  readonly body: unknown;
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

export async function withServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
  run: (baseURL: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      json(response, 500, { error: { message: error instanceof Error ? error.message : "handler failed" } });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}
