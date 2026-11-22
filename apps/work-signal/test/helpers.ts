import { env, exports } from "cloudflare:workers";

const encoder = new TextEncoder();

export function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function signToken(
  claims: Record<string, unknown>,
  secret: string = env.WORK_SIGNAL_TOKEN_SECRET,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A fresh client IP, so the real per-IP rate limiters (shared by every test)
 * only count the requests a test sends on purpose.
 */
export function randomIp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes).join(".");
}

export function validClaims(
  projectId: string,
  workerId = "worker-1",
  orgId = `org-${projectId}`,
) {
  return {
    pid: projectId,
    sub: workerId,
    oid: orgId,
    exp: nowSeconds() + 3600,
  };
}

export function connectRequest(
  projectId: string,
  token: string,
  ip: string = randomIp(),
): Promise<Response> {
  return exports.default.fetch(
    `http://work-signal/projects/${projectId}/connect?token=${encodeURIComponent(token)}`,
    { headers: { Upgrade: "websocket", "cf-connecting-ip": ip } },
  );
}

export interface TestSocket {
  socket: WebSocket;
  messages: string[];
  nextMessage(): Promise<string>;
}

export async function connectWorker(
  projectId: string,
  workerId = "worker-1",
): Promise<TestSocket> {
  const response = await connectRequest(
    projectId,
    await signToken(validClaims(projectId, workerId)),
  );
  return acceptTestSocket(response);
}

export function acceptTestSocket(response: Response): TestSocket {
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) {
    throw new Error(`connect failed: ${String(response.status)}`);
  }
  socket.accept();
  const messages: string[] = [];
  const waiters: ((message: string) => void)[] = [];
  let cursor = 0;
  socket.addEventListener("message", (event) => {
    messages.push(typeof event.data === "string" ? event.data : "<binary>");
    const waiter = waiters.shift();
    if (waiter) waiter(messages[cursor++] ?? "");
  });
  return {
    socket,
    messages,
    nextMessage: () =>
      new Promise<string>((resolve) => {
        if (cursor < messages.length) resolve(messages[cursor++] ?? "");
        else waiters.push(resolve);
      }),
  };
}

export function notifyRequest(
  projectId: string,
  secret: string = env.WORK_SIGNAL_NOTIFY_SECRET,
  ip: string = randomIp(),
): Promise<Response> {
  return exports.default.fetch(
    `http://work-signal/projects/${projectId}/notify`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "cf-connecting-ip": ip },
    },
  );
}

/**
 * Sends requests until one is rate limited (429) or `max` have been sent, and
 * returns every status. Limiter windows are aligned to the wall clock, so a
 * burst can straddle a rollover; callers allow up to two windows' worth.
 */
export async function statusesUntilLimited(
  send: () => Promise<Response>,
  max: number,
): Promise<number[]> {
  const statuses: number[] = [];
  while (statuses.length < max) {
    const response = await send();
    response.webSocket?.accept();
    response.webSocket?.close();
    statuses.push(response.status);
    if (response.status === 429) break;
  }
  return statuses;
}

export function projectStub(projectId: string) {
  return env.PROJECT_WORK_SIGNAL.get(
    env.PROJECT_WORK_SIGNAL.idFromName(projectId),
  );
}
