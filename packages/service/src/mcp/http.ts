import { createServer, type Server } from "node:http";

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import {
  localhostHostValidation, localhostOriginValidation, toNodeHandler,
} from "@modelcontextprotocol/node";

export interface SurfaceLoomMcpHttpServer {
  readonly url: URL;
  close(): Promise<void>;
}

export interface ListenMcpOptions {
  readonly hostname?: "127.0.0.1" | "::1";
  readonly port?: number;
}

export async function listenSurfaceLoomMcp(
  handler: McpHttpHandler,
  options: ListenMcpOptions = {},
): Promise<SurfaceLoomMcpHttpServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be 0..65535.");
  }
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const route = toNodeHandler(handler);
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    let pathname: string;
    try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid request URL.");
      return;
    }
    if (pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    void route(request as unknown as Parameters<typeof route>[0],
      response as unknown as Parameters<typeof route>[1]);
  });
  await listen(server, port, hostname);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("MCP server has no TCP address.");
  const host = hostname === "::1" ? "[::1]" : hostname;
  return Object.freeze({ url: new URL(`http://${host}:${address.port}/mcp`),
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await close(server);
    } });
}

function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, hostname);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error); });
  });
}
