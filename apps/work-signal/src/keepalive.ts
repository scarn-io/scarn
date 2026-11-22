/**
 * Keepalive frames answered by the Durable Object's WebSocket auto-response,
 * so they never wake a hibernated object.
 *
 * `packages/worker/src/work/task-run/infra/work-signal-client.ts` duplicates
 * these values; `test/keepalive.test.ts` keeps the two in sync.
 */
export const KEEPALIVE_PING = "ping";
export const KEEPALIVE_PONG = "pong";
