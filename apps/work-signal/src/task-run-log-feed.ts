import { DurableObject } from "cloudflare:workers";
import { KEEPALIVE_PING, KEEPALIVE_PONG } from "./keepalive";
import {
  byteLength,
  type Json,
  type LogLine,
  MAX_BATCH_BYTES,
  MAX_BATCH_LINES,
  MAX_READ_LINES,
  parseJsonObject,
  parseLogLines,
} from "./log-lines";

/** How long a sealed feed stays readable before its alarm deletes it. */
export const SEALED_FEED_TTL_MS = 60 * 60 * 1000;

/**
 * Runs have no hard maximum duration (`executionTimeoutSeconds` is optional),
 * so this is a fixed ceiling of a day plus core's
 * `ABANDONED_LOG_GRACE_MINUTES` (5 minutes).
 */
export const ABANDONED_FEED_TTL_MS = (24 * 60 + 5) * 60 * 1000;

/** Stored appends allowed per feed within any {@link APPEND_WINDOW_MS}. */
export const MAX_APPENDS_PER_WINDOW = 60;
export const APPEND_WINDOW_MS = 60 * 1000;

/** Total stored batch bytes a feed may hold before appends are `feed-full`. */
export const MAX_FEED_BYTES = 64 * 1024 * 1024;

/** A writer is closed on this many offending nacks within the window. */
export const MAX_WRITER_OFFENCES = 3;
export const OFFENCE_WINDOW_MS = 60 * 1000;

/** Reader sockets a feed holds at once; a connect over the cap gets 429. */
export const MAX_READERS = 20;

export type AppendError =
  "sealed" | "too-many-lines" | "too-large" | "rate-limited" | "feed-full";

export type AppendResult = { nextOffset: number } | { error: AppendError };

export interface ReadResult {
  lines: LogLine[];
  nextOffset: number;
}

export type FeedRole = "writer" | "reader";

export type NackCode = AppendError | "bad-request" | "internal";

export interface SocketAttachment {
  role: FeedRole;
  exp: number;
  offences?: number;
  offenceWindowStart?: number;
}

/** Set by the Worker after it verifies the token; never by the client. */
export const ROLE_HEADER = "X-Log-Feed-Role";
export const FROM_HEADER = "X-Log-Feed-From";
export const TOKEN_EXP_HEADER = "X-Log-Feed-Token-Exp";

export const CLOSE_SEALED = 1000;
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_TOKEN_EXPIRED = 4001;
export const CLOSE_WRITER_REPLACED = 4002;

const SEALED_MESSAGE = JSON.stringify({ t: "sealed" });

const OFFENDING_ERRORS: ReadonlySet<AppendError> = new Set([
  "rate-limited",
  "feed-full",
]);

type MessageId = string | number | null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS batches (
    last_seq INTEGER PRIMARY KEY,
    first_seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    appended_at INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sealed INTEGER NOT NULL,
    sealed_at INTEGER
  );
`;

/**
 * One instance per task run (`idFromName(taskRunId)`). Holds the run's live
 * log lines until the API archives them, then seals and later deletes itself.
 *
 * Storage is one SQLite row per appended batch, keyed by the batch's highest
 * `seq`, so an append costs one row written. Appends drop lines at or below
 * the highest stored `seq`, which makes a re-sent batch harmless.
 *
 * Per-feed caps live in `append`, so they cover the socket and the internal
 * route alike: at most {@link MAX_APPENDS_PER_WINDOW} stored appends per
 * rolling {@link APPEND_WINDOW_MS} (`rate-limited`) and at most
 * {@link MAX_FEED_BYTES} of stored batches (`feed-full`). Each row carries its
 * `appended_at` and the running `total_bytes`, so the caps cost no extra rows
 * written and `load` restores them from the newest rows. A writer that draws
 * {@link MAX_WRITER_OFFENCES} such nacks within {@link OFFENCE_WINDOW_MS} is
 * closed with {@link CLOSE_POLICY_VIOLATION}.
 *
 * Two alarms bound how long a feed lives: the first append schedules deletion
 * of an abandoned feed after {@link ABANDONED_FEED_TTL_MS}, and `seal`
 * replaces it with deletion after {@link SEALED_FEED_TTL_MS}. Like
 * `ProjectWorkSignal`, it has no timers or outgoing connections so it can
 * hibernate.
 *
 * WebSockets arrive from the Worker's `GET /task-runs/:taskRunId/ws` with the
 * verified role in {@link ROLE_HEADER}, tagged `"writer"` or `"reader"`:
 * - Writer (at most one; a newer one closes the older with
 *   {@link CLOSE_WRITER_REPLACED}) sends `{t:"append", id, lines}` and gets
 *   `{t:"ack", id, nextOffset}` or `{t:"nack", id, code}`.
 * - Reader gets the lines after `from` as `{t:"lines", lines}` pages, then
 *   `{t:"caught-up", nextOffset}`, then every newly stored batch. Anything it
 *   sends besides the keepalive closes it with {@link CLOSE_POLICY_VIOLATION}.
 *   At most {@link MAX_READERS} readers connect at once; past that the
 *   upgrade is refused with 429.
 * - Every append, over the socket or through the internal route, is pushed to
 *   readers. Sealing sends `{t:"sealed"}` to every socket and closes the
 *   writer.
 */
export class TaskRunLogFeed extends DurableObject {
  private maxSeq = -1;
  private sealed = false;
  private totalBytes = 0;
  private recentAppends: number[] = [];

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG),
    );
    void ctx.blockConcurrencyWhile(() => {
      this.load();
      return Promise.resolve();
    });
  }

  override fetch(request: Request): Response {
    const role = request.headers.get(ROLE_HEADER);
    const exp = Number(request.headers.get(TOKEN_EXP_HEADER));
    const from = Number(request.headers.get(FROM_HEADER));
    if (
      (role !== "writer" && role !== "reader") ||
      !Number.isFinite(exp) ||
      !Number.isSafeInteger(from)
    ) {
      return new Response("Bad request", { status: 400 });
    }
    if (
      role === "reader" &&
      this.ctx.getWebSockets("reader").length >= MAX_READERS
    ) {
      this.warnRejected("reader-cap");
      return new Response("Too many readers", { status: 429 });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    if (role === "writer") {
      for (const previous of this.ctx.getWebSockets("writer")) {
        previous.close(CLOSE_WRITER_REPLACED, "replaced by a newer writer");
      }
    }
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, exp } satisfies SocketAttachment);
    if (role === "reader") {
      this.catchUp(server, from);
    } else if (this.sealed) {
      send(server, SEALED_MESSAGE);
      server.close(CLOSE_SEALED, "sealed");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment =
      socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role !== "writer") {
      socket.close(CLOSE_POLICY_VIOLATION, "readers may only ping");
      return;
    }
    const request =
      typeof message === "string"
        ? parseClientMessage(message)
        : { id: null, lines: null };
    if (attachment.exp <= Date.now() / 1000) {
      socket.close(CLOSE_TOKEN_EXPIRED, "token expired");
      return;
    }
    if (!request.lines) {
      sendNack(socket, request.id, "bad-request");
      return;
    }
    let result: AppendResult;
    try {
      result = await this.append(request.lines);
    } catch {
      sendNack(socket, request.id, "internal");
      return;
    }
    if ("error" in result) {
      sendNack(socket, request.id, result.error);
      if (OFFENDING_ERRORS.has(result.error)) {
        recordOffence(socket);
      }
      return;
    }
    send(
      socket,
      JSON.stringify({
        t: "ack",
        id: request.id,
        nextOffset: result.nextOffset,
      }),
    );
  }

  override webSocketClose(): void {}

  override webSocketError(): void {}

  /**
   * Rejections made here never reach the edge Worker's metering, so they go
   * to Workers Logs instead.
   */
  private rejected(error: "rate-limited" | "feed-full"): AppendResult {
    this.warnRejected(error);
    return { error };
  }

  private warnRejected(reason: "rate-limited" | "feed-full" | "reader-cap") {
    console.warn("log feed rejected", {
      reason,
      tid: this.ctx.id.name ?? this.ctx.id.toString(),
    });
  }

  async append(lines: LogLine[]): Promise<AppendResult> {
    if (this.sealed) return { error: "sealed" };
    if (lines.length > MAX_BATCH_LINES) return { error: "too-many-lines" };
    const fresh = freshLines(lines, this.maxSeq);
    if (fresh.length === 0) return { nextOffset: this.nextOffset() };
    const body = JSON.stringify(fresh);
    const bodyBytes = byteLength(body);
    if (bodyBytes > MAX_BATCH_BYTES) return { error: "too-large" };

    const now = Date.now();
    this.recentAppends = this.recentAppends.filter(
      (at) => at > now - APPEND_WINDOW_MS,
    );
    if (this.recentAppends.length >= MAX_APPENDS_PER_WINDOW) {
      return this.rejected("rate-limited");
    }
    const totalBytes = this.totalBytes + bodyBytes;
    if (totalBytes > MAX_FEED_BYTES) return this.rejected("feed-full");

    const firstSeq = fresh[0]?.seq ?? 0;
    const lastSeq = fresh[fresh.length - 1]?.seq ?? 0;
    const isFirstWrite = this.maxSeq < 0;
    this.ctx.storage.sql.exec(
      "INSERT INTO batches (last_seq, first_seq, body, appended_at, total_bytes) VALUES (?, ?, ?, ?, ?)",
      lastSeq,
      firstSeq,
      body,
      now,
      totalBytes,
    );
    this.maxSeq = lastSeq;
    this.totalBytes = totalBytes;
    this.recentAppends.push(now);
    this.broadcastToReaders(linesMessage(body));
    if (isFirstWrite) {
      await this.ctx.storage.setAlarm(Date.now() + ABANDONED_FEED_TTL_MS);
    }
    return { nextOffset: this.nextOffset() };
  }

  /** Lines with `seq > fromSeq`, ascending, at most `limit` of them. */
  read(fromSeq: number, limit: number): ReadResult {
    const cap = Math.min(Math.max(Math.floor(limit), 1), MAX_READ_LINES);
    const lines: LogLine[] = [];
    const cursor = this.ctx.storage.sql.exec<{ body: string }>(
      "SELECT body FROM batches WHERE last_seq > ? ORDER BY last_seq",
      fromSeq,
    );
    for (const { body } of cursor) {
      for (const line of JSON.parse(body) as LogLine[]) {
        if (line.seq <= fromSeq) continue;
        lines.push(line);
        if (lines.length >= cap) break;
      }
      if (lines.length >= cap) break;
    }
    return { lines, nextOffset: lines.at(-1)?.seq ?? fromSeq };
  }

  readAll(): LogLine[] {
    return this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM batches ORDER BY last_seq")
      .toArray()
      .flatMap(({ body }) => JSON.parse(body) as LogLine[]);
  }

  /** Rejects further appends and schedules deletion. Idempotent. */
  async seal(): Promise<void> {
    if (this.sealed) return;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (id, sealed, sealed_at) VALUES (1, 1, ?)",
      Date.now(),
    );
    this.sealed = true;
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, SEALED_MESSAGE);
    }
    for (const writer of this.ctx.getWebSockets("writer")) {
      writer.close(CLOSE_SEALED, "sealed");
    }
    await this.ctx.storage.setAlarm(Date.now() + SEALED_FEED_TTL_MS);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.load();
  }

  private load(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(SCHEMA);
    addMissingBatchColumns(sql);
    const recent = sql
      .exec<{ last_seq: number; total_bytes: number; appended_at: number }>(
        "SELECT last_seq, total_bytes, appended_at FROM batches ORDER BY last_seq DESC LIMIT ?",
        MAX_APPENDS_PER_WINDOW,
      )
      .toArray();
    this.maxSeq = recent[0]?.last_seq ?? -1;
    this.totalBytes = recent[0]?.total_bytes ?? 0;
    this.recentAppends = recent.map((row) => row.appended_at).reverse();
    this.sealed =
      sql.exec("SELECT 1 FROM meta WHERE sealed = 1").toArray().length > 0;
  }

  private nextOffset(): number {
    return Math.max(this.maxSeq, 0);
  }

  /**
   * Sends the lines after `fromSeq` as pages of whole stored batches, each
   * page at most {@link MAX_BATCH_BYTES} unless one batch alone is larger.
   */
  private catchUp(socket: WebSocket, fromSeq: number): void {
    const cursor = this.ctx.storage.sql.exec<{ body: string }>(
      "SELECT body FROM batches WHERE last_seq > ? ORDER BY last_seq",
      fromSeq,
    );
    let page: LogLine[] = [];
    let pageBytes = 0;
    for (const { body } of cursor) {
      const batch = (JSON.parse(body) as LogLine[]).filter(
        (line) => line.seq > fromSeq,
      );
      const batchBytes = byteLength(body);
      if (page.length > 0 && pageBytes + batchBytes > MAX_BATCH_BYTES) {
        send(socket, linesMessage(JSON.stringify(page)));
        page = [];
        pageBytes = 0;
      }
      page.push(...batch);
      pageBytes += batchBytes;
    }
    if (page.length > 0) send(socket, linesMessage(JSON.stringify(page)));
    send(
      socket,
      JSON.stringify({
        t: "caught-up",
        nextOffset: Math.max(this.maxSeq, fromSeq, 0),
      }),
    );
    if (this.sealed) send(socket, SEALED_MESSAGE);
  }

  private broadcastToReaders(message: string): void {
    for (const reader of this.ctx.getWebSockets("reader")) {
      send(reader, message);
    }
  }
}

function linesMessage(linesJson: string): string {
  return `{"t":"lines","lines":${linesJson}}`;
}

function send(socket: WebSocket, message: string): void {
  try {
    socket.send(message);
  } catch {
    return;
  }
}

function sendNack(socket: WebSocket, id: MessageId, code: NackCode): void {
  send(socket, JSON.stringify({ t: "nack", id, code }));
}

/**
 * Counts a `rate-limited` or `feed-full` nack against the writer in its
 * socket attachment (no SQLite write) and closes it with
 * {@link CLOSE_POLICY_VIOLATION} on the {@link MAX_WRITER_OFFENCES}th within
 * {@link OFFENCE_WINDOW_MS}.
 */
function recordOffence(socket: WebSocket): void {
  const attachment = socket.deserializeAttachment() as SocketAttachment;
  const now = Date.now();
  const windowOpen =
    attachment.offenceWindowStart !== undefined &&
    now - attachment.offenceWindowStart < OFFENCE_WINDOW_MS;
  const offences = windowOpen ? (attachment.offences ?? 0) + 1 : 1;
  if (offences >= MAX_WRITER_OFFENCES) {
    socket.close(CLOSE_POLICY_VIOLATION, "too many rejected appends");
    return;
  }
  socket.serializeAttachment({
    ...attachment,
    offences,
    offenceWindowStart: windowOpen ? attachment.offenceWindowStart : now,
  } satisfies SocketAttachment);
}

/**
 * Feeds created before `appended_at` / `total_bytes` existed lack them. Drop
 * this once every such feed has expired (at most {@link ABANDONED_FEED_TTL_MS}
 * after deploy).
 */
function addMissingBatchColumns(sql: SqlStorage): void {
  const present = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('batches')")
      .toArray()
      .map((column) => column.name),
  );
  for (const column of ["appended_at", "total_bytes"]) {
    if (!present.has(column)) {
      sql.exec(
        `ALTER TABLE batches ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }
}

/**
 * Parses `{t:"append", id, lines}`. `lines` is `null` when the message is not
 * a well-formed append; `id` is kept whenever it is a string or number so the
 * nack can name it.
 */
function parseClientMessage(text: string): {
  id: MessageId;
  lines: LogLine[] | null;
} {
  const body = parseJsonObject(text);
  const id = messageId(body?.["id"]);
  if (body?.["t"] !== "append") return { id, lines: null };
  return { id, lines: parseLogLines(body["lines"]) };
}

function messageId(value: Json | undefined): MessageId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/** Lines above `maxSeq`, sorted by `seq` with duplicates removed. */
function freshLines(lines: LogLine[], maxSeq: number): LogLine[] {
  const sorted = lines
    .filter((line) => line.seq > maxSeq)
    .sort((left, right) => left.seq - right.seq);
  return sorted.filter((line, i) => i === 0 || line.seq !== sorted[i - 1]?.seq);
}
