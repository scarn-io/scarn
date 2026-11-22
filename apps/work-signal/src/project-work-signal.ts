import { DurableObject } from "cloudflare:workers";
import { KEEPALIVE_PING, KEEPALIVE_PONG } from "./keepalive";

/**
 * One instance per project. Holds the hibernatable WebSockets of that
 * project's idle workers and pings them when work may be available.
 *
 * It deliberately has no timers, no `accept()` and no outgoing sockets: any of
 * those would keep the object awake (and billing) between notifies.
 *
 * Clients only ever send the keepalive, which the auto-response answers
 * without waking the object; anything else closes the socket with
 * {@link CLOSE_POLICY_VIOLATION}. Each socket is tagged with its worker id
 * (the token's `sub`). A connect is refused with 429 when the project already
 * holds {@link MAX_SOCKETS_PER_PROJECT} sockets, or when that worker id holds
 * {@link MAX_SOCKETS_PER_WORKER} live ones; its expired sockets are closed
 * first so they never hold a slot.
 */
export interface SocketAttachment {
  workerId: string;
  exp: number;
}

export const WORKER_ID_HEADER = "X-Work-Signal-Worker-Id";
export const TOKEN_EXP_HEADER = "X-Work-Signal-Token-Exp";
export const WORK_MESSAGE = JSON.stringify({ t: "work" });

/** Covers a token-refresh overlap; `scarn work` sends a per-process id. */
export const MAX_SOCKETS_PER_WORKER = 3;
/** Far above any expected fleet size for one project. */
export const MAX_SOCKETS_PER_PROJECT = 500;

export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_TOKEN_EXPIRED = 4001;

type RejectReason = "worker-socket-cap" | "project-socket-cap";

export class ProjectWorkSignal extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG),
    );
  }

  override fetch(request: Request): Response {
    const workerId = request.headers.get(WORKER_ID_HEADER);
    const exp = Number(request.headers.get(TOKEN_EXP_HEADER));
    if (!workerId || !Number.isFinite(exp)) {
      return new Response("Bad request", { status: 400 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_PROJECT) {
      return this.rejected("project-socket-cap");
    }
    const workerSockets = this.ctx
      .getWebSockets(workerId)
      .filter((socket) => !closeIfExpired(socket));
    if (workerSockets.length >= MAX_SOCKETS_PER_WORKER) {
      return this.rejected("worker-socket-cap");
    }
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server, [workerId]);
    server.serializeAttachment({ workerId, exp } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends `{"t":"work"}` to every live socket; returns how many were sent. */
  notify(): number {
    let notified = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (closeIfExpired(socket)) continue;
      socket.send(WORK_MESSAGE);
      notified++;
    }
    return notified;
  }

  override webSocketMessage(socket: WebSocket): void {
    socket.close(CLOSE_POLICY_VIOLATION, "clients may only ping");
  }

  override webSocketClose(): void {}

  override webSocketError(): void {}

  /**
   * Rejections made here never reach the edge Worker's metering, so they go
   * to Workers Logs instead.
   */
  private rejected(reason: RejectReason): Response {
    console.warn("work signal rejected", {
      reason,
      pid: this.ctx.id.name ?? this.ctx.id.toString(),
    });
    return new Response("Too many sockets", { status: 429 });
  }
}

function closeIfExpired(socket: WebSocket): boolean {
  const attachment = socket.deserializeAttachment() as SocketAttachment | null;
  if (attachment && attachment.exp > Date.now() / 1000) return false;
  socket.close(CLOSE_TOKEN_EXPIRED, "token expired");
  return true;
}
