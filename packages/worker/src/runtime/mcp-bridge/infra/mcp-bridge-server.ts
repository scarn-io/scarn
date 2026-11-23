import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  MCP_BRIDGE_CALL_METHOD,
  MCP_BRIDGE_CALL_PATH,
  mcpBridgeCallRequestSchema,
  type McpBridgeCallResponse,
  type McpBridgeErrorResponse,
} from "@scarn/sdk/contracts/mcp-bridge";
import type { McpBridge } from "../application/mcp-bridge";

/**
 * The HTTP face of one MCP bridge session (ADR 0016). It serves
 * `POST /mcp/call` with a JSON `{ server, tool, args, timeoutMs? }` body.
 *
 *   - 401 for a missing or wrong `Authorization: Bearer` token (compared in
 *     constant time, never logged), checked before anything else;
 *   - 404 for any other method or path, and for a server the step didn't
 *     declare;
 *   - 413 for a body over {@link MAX_MCP_BRIDGE_REQUEST_BYTES};
 *   - 400 for a body that isn't JSON or doesn't match the request schema;
 *   - 503 when the call was aborted (the run is ending or the bridge stopped);
 *   - 200 with the call's outcome.
 *
 * Every non-200 carries `{ error }`. A client that disconnects mid-call
 * aborts its call.
 */

export const MAX_MCP_BRIDGE_REQUEST_BYTES = 1024 * 1024;

export type McpBridgeServerOptions = {
  bridge: McpBridge;
  token: string;
  bindAddress: string;
};

export class McpBridgeServer {
  private readonly bridge: McpBridge;
  private readonly expectedAuthorization: Buffer;
  private readonly bindAddress: string;
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(options: McpBridgeServerOptions) {
    this.bridge = options.bridge;
    this.expectedAuthorization = Buffer.from(`Bearer ${options.token}`);
    this.bindAddress = options.bindAddress;
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, this.bindAddress, () => {
        this.server.off("error", reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await closed;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.isAuthorized(req.headers.authorization)) {
        respondError(res, 401, "Missing or invalid bearer token");
        return;
      }
      if (
        req.method !== MCP_BRIDGE_CALL_METHOD ||
        req.url !== MCP_BRIDGE_CALL_PATH
      ) {
        respondError(res, 404, "Not found");
        return;
      }
      const body = await readBody(req);
      if (body === null) {
        respondError(
          res,
          413,
          `Request body is over ${String(MAX_MCP_BRIDGE_REQUEST_BYTES)} bytes`,
        );
        return;
      }
      const parsed = mcpBridgeCallRequestSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        respondError(res, 400, "Request body is not a valid MCP bridge call");
        return;
      }
      const disconnected = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) disconnected.abort();
      });
      const result = await this.bridge.call(parsed.data, disconnected.signal);
      switch (result.status) {
        case "not_declared":
          respondError(
            res,
            404,
            `MCP server "${parsed.data.server}" is not declared by this step`,
          );
          return;
        case "aborted":
          respondError(res, 503, "The MCP call was aborted");
          return;
        case "outcome":
          respondJson(res, 200, result.response);
          return;
      }
    } catch {
      respondError(res, 500, "Internal MCP bridge error");
    }
  }

  private isAuthorized(header: string | undefined): boolean {
    if (header === undefined) {
      return false;
    }
    const actual = Buffer.from(header);
    return (
      actual.length === this.expectedAuthorization.length &&
      timingSafeEqual(actual, this.expectedAuthorization)
    );
  }
}

const INVALID_JSON = Symbol("invalid-json");

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

/**
 * Reads the body, or returns `null` once it exceeds the limit. An oversized
 * body is still drained (not stored) so the 413 reaches the client.
 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_MCP_BRIDGE_REQUEST_BYTES) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= MAX_MCP_BRIDGE_REQUEST_BYTES) {
      chunks.push(buffer);
    }
  }
  if (size > MAX_MCP_BRIDGE_REQUEST_BYTES) {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respondError(res: ServerResponse, status: number, error: string) {
  const body: McpBridgeErrorResponse = { error };
  respondJson(res, status, body);
}

function respondJson(
  res: ServerResponse,
  status: number,
  body: McpBridgeCallResponse | McpBridgeErrorResponse,
): void {
  if (res.headersSent || res.destroyed) {
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}
