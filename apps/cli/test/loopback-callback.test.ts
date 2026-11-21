import { afterEach, describe, expect, test } from "bun:test";
import { CliError } from "../src/lib/cli-error";
import {
  bindLoopbackCallback,
  type LoopbackCallbackListener,
} from "../src/lib/loopback-callback";

/**
 * The loopback listener against real sockets: only a `GET` on the path with
 * the expected `state` ends the wait, and the listener always closes.
 */

/** Awaits a rejection and returns the error. */
async function rejectionOf(promise: Promise<object>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected an Error, received ${String(error)}`);
  }
  throw new Error("Expected a rejection, but it resolved.");
}

const STATE = "expected-state";
const open: LoopbackCallbackListener[] = [];

afterEach(() => {
  for (const listener of open.splice(0)) listener.close();
});

const bind = async (
  input: Partial<Parameters<typeof bindLoopbackCallback>[0]> = {},
) => {
  const listener = await bindLoopbackCallback({
    host: "127.0.0.1",
    port: 0,
    path: "/callback",
    ...input,
  });
  open.push(listener);
  return listener;
};

const isClosed = async (url: string) => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

describe("bindLoopbackCallback", () => {
  test("binds a dynamic port and reports it in the redirect URI", async () => {
    const listener = await bind();
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.redirectUri).toBe(
      `http://127.0.0.1:${String(listener.port)}/callback`,
    );
  });

  test("resolves with the code and iss, and serves a page with no script", async () => {
    const listener = await bind();
    const waiting = listener.waitFor({ expectedState: STATE });
    const response = await fetch(
      `${listener.redirectUri}?code=the-code&state=${STATE}&iss=https%3A%2F%2Fissuer.test`,
    );
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("You can close this tab");
    expect(page).not.toContain("<script");
    expect(await waiting).toEqual({
      kind: "code",
      code: "the-code",
      state: STATE,
      iss: "https://issuer.test",
    });
    expect(await isClosed(listener.redirectUri)).toBe(true);
  });

  test("resolves with a provider error, keeping iss and ignoring the description", async () => {
    const listener = await bind();
    const waiting = listener.waitFor({ expectedState: STATE });
    await fetch(
      `${listener.redirectUri}?error=access_denied&error_description=nope&state=${STATE}&iss=https%3A%2F%2Fi.test`,
    );
    expect(await waiting).toEqual({
      kind: "error",
      error: "access_denied",
      state: STATE,
      iss: "https://i.test",
    });
  });

  test("a wrong state or a wrong path is a 404 and keeps waiting", async () => {
    const listener = await bind();
    const waiting = listener.waitFor({ expectedState: STATE });
    const base = `http://127.0.0.1:${String(listener.port)}`;

    expect(
      (await fetch(`${listener.redirectUri}?code=c&state=other`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/elsewhere?code=c&state=${STATE}`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${listener.redirectUri}?code=c&state=${STATE}`, {
          method: "POST",
        })
      ).status,
    ).toBe(404);

    expect(
      (await fetch(`${listener.redirectUri}?code=right&state=${STATE}`)).status,
    ).toBe(200);
    expect(await waiting).toMatchObject({ kind: "code", code: "right" });
  });

  test("times out with a clear error and closes", async () => {
    const listener = await bind();
    const error = await rejectionOf(
      listener.waitFor({ expectedState: STATE, timeoutMs: 20 }),
    );
    expect(error).toMatchObject({ code: "loopback_timeout" });
    expect(await isClosed(listener.redirectUri)).toBe(true);
  });

  test("an abort (Ctrl-C) rejects and closes", async () => {
    const listener = await bind();
    const controller = new AbortController();
    const waiting = listener.waitFor({
      expectedState: STATE,
      signal: controller.signal,
    });
    controller.abort();
    const error = await rejectionOf(waiting);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "loopback_cancelled" });
    expect(await isClosed(listener.redirectUri)).toBe(true);
  });

  test("a port in use names the port, and says when the client fixes it", async () => {
    const taken = await bind();
    const binding = bindLoopbackCallback({
      host: "127.0.0.1",
      port: taken.port,
      path: "/callback",
      portFixedBy: "client",
    });
    const error = await rejectionOf(binding);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "loopback_port_in_use" });
    expect(error.message).toContain(String(taken.port));
    expect(error.message).toContain("fixed by the client");
  });

  test("localhost answers on both IPv4 and IPv6 loopback", async () => {
    const listener = await bind({ host: "localhost" });
    expect(listener.redirectUri).toBe(
      `http://localhost:${String(listener.port)}/callback`,
    );
    listener.waitFor({ expectedState: STATE }).catch(() => undefined);
    const v4 = await fetch(
      `http://127.0.0.1:${String(listener.port)}/callback?state=wrong`,
    );
    expect(v4.status).toBe(404);
    const v6 = await fetch(
      `http://[::1]:${String(listener.port)}/callback?state=wrong`,
    ).catch(() => null);
    if (v6 !== null) expect(v6.status).toBe(404);
  });
});
