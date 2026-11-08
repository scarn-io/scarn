import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { CredentialRelay } from "../application/credential-relay";
import { GitCredentialProtocolError } from "../domain/git-credential-protocol";

/**
 * The HTTP face of one relay session. It serves
 * `POST /credentials/:kind/:operation` with a `text/plain` body in git's
 * credential format; only `kind = "git"` exists (decision 13).
 *
 *   - 401 for a missing or wrong `Authorization: Bearer` token (compared in
 *     constant time, never logged), checked before anything else;
 *   - 404 for any other method, path or kind;
 *   - 413 for a body over {@link MAX_CREDENTIAL_REQUEST_BYTES};
 *   - 400 for a {@link GitCredentialProtocolError} (unknown operation or a
 *     malformed `get`);
 *   - 200 with the relay's body, or 204 when the relay ignores the request.
 */

export const MAX_CREDENTIAL_REQUEST_BYTES = 16 * 1024;

const ROUTE = /^\/credentials\/([^/]+)\/([^/]+)$/;

export type CredentialRelayServerOptions = {
  relay: CredentialRelay;
  token: string;
  bindAddress: string;
};

export class CredentialRelayServer {
  private readonly relay: CredentialRelay;
  private readonly expectedAuthorization: Buffer;
  private readonly bindAddress: string;
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(options: CredentialRelayServerOptions) {
    this.relay = options.relay;
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
        respond(res, 401);
        return;
      }
      const match = ROUTE.exec(req.url ?? "");
      if (req.method !== "POST" || !match || match[1] !== "git") {
        respond(res, 404);
        return;
      }
      const body = await readBody(req);
      if (body === null) {
        respond(res, 413);
        return;
      }
      const outcome = await this.relay.handleGit(match[2] ?? "", body);
      if (outcome.status === "ignored") {
        respond(res, 204);
        return;
      }
      respond(res, 200, outcome.body);
    } catch (error) {
      respond(res, error instanceof GitCredentialProtocolError ? 400 : 500);
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

/**
 * Reads the body, or returns `null` once it exceeds the limit. An oversized
 * body is still drained (not stored) so the 413 reaches the client.
 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_CREDENTIAL_REQUEST_BYTES) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= MAX_CREDENTIAL_REQUEST_BYTES) {
      chunks.push(buffer);
    }
  }
  if (size > MAX_CREDENTIAL_REQUEST_BYTES) {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respond(res: ServerResponse, status: number, body?: string): void {
  if (res.headersSent) {
    return;
  }
  if (body === undefined) {
    res.writeHead(status, { Connection: "close" });
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
