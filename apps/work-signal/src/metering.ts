/**
 * Metering events, written to the `EDGE_EVENTS` Analytics Engine dataset
 * (`edge_events`) by the edge Worker only: one per connect, per rejection and
 * per authorised notify. Never per append and never from a Durable Object, so
 * metering cannot keep an object awake. Successful `/internal/*` calls are not
 * recorded; the API already knows about them.
 *
 * Columns (queried as `index1`, `blob1`…`blob6`, `double1`…`double2`):
 * - `index1`: `oid`, else `pid`, else empty.
 * - `blob1`…`blob6`: event, pid, oid, tid, sub, reason.
 * - `double1`: always 1; `double2`: workers woken by a notify, else 0.
 *
 * Ids on `rejected` events with reason `auth` or `rate_ip` come from the
 * request path, not a verified token, so they are only as trustworthy as the
 * caller.
 */
export type EdgeEvent =
  | "signal_connect"
  | "feed_writer_connect"
  | "feed_reader_connect"
  | "notify"
  | "rejected";

export type RejectReason =
  | "auth"
  | "rate_ip"
  | "rate_worker"
  | "rate_org"
  | "rate_writer"
  | "rate_reader";

export interface EventContext {
  pid?: string;
  oid?: string;
  tid?: string;
  sub?: string;
}

export interface MeteringEvent extends EventContext {
  event: EdgeEvent;
  reason?: RejectReason;
  notified?: number;
}

/** Writes one data point; a metering failure never fails the request. */
export function record(env: Cloudflare.Env, event: MeteringEvent): void {
  try {
    env.EDGE_EVENTS.writeDataPoint({
      indexes: [event.oid ?? event.pid ?? ""],
      blobs: [
        event.event,
        event.pid ?? "",
        event.oid ?? "",
        event.tid ?? "",
        event.sub ?? "",
        event.reason ?? "",
      ],
      doubles: [1, event.notified ?? 0],
    });
  } catch (error) {
    console.warn("metering write failed", error);
  }
}

export function recordRejection(
  env: Cloudflare.Env,
  reason: RejectReason,
  context: EventContext,
): void {
  record(env, { event: "rejected", reason, ...context });
}
