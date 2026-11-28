/**
 * The network peer's IP for a request, recorded by the entry point that
 * received it. Every entry hands Elysia a bare `Request` through
 * `app.handle`, so Elysia's `server.requestIP` is unavailable; the entry
 * records the address it knows (Bun's socket peer, a Function URL's
 * `sourceIp`) here instead. Never derived from a request header.
 */
const clientIps = new WeakMap<Request, string>();

export const setRequestClientIp = (
  request: Request,
  ip: string | null | undefined,
): void => {
  if (ip) {
    clientIps.set(request, ip);
  }
};

export const getRequestClientIp = (request: Request): string | null =>
  clientIps.get(request) ?? null;
