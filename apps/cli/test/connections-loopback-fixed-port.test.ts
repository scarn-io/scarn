import { describe, expect, test } from "bun:test";
import { runLoopbackSignIn } from "../src/lib/connections-loopback";
import {
  bindLoopbackCallback,
  type BindLoopbackCallbackInput,
} from "../src/lib/loopback-callback";
import {
  baseInput,
  candidateConnection,
  fakeApi,
  ports,
  PROJECT_ID,
  rejectionOf,
} from "./connections-loopback-support";
import { createReporterRecorder } from "./utils";

/**
 * Loopback sign-ins on a fixed port: a supplied client's one redirect, bound
 * exactly before start, and the server's fallback port, moved to after start.
 */

describe("runLoopbackSignIn on a fixed port", () => {
  test("a supplied client's redirect is bound exactly, on localhost, before start", async () => {
    const free = await bindLoopbackCallback({
      host: "127.0.0.1",
      port: 0,
      path: "/callback",
    });
    const fixedPort = free.port;
    free.close();
    const supplied = `http://localhost:${String(fixedPort)}/oauth/done`;
    const { api, calls } = fakeApi();
    const binds: BindLoopbackCallbackInput[] = [];
    const { reporter } = createReporterRecorder();

    const outcome = await runLoopbackSignIn({
      ...baseInput,
      target: {
        kind: "reconnect",
        connectionId: "conn-1",
        suppliedRedirectUri: supplied,
      },
      yes: true,
      reporter,
      ports: ports(api, {
        bindListener: (input) => {
          binds.push(input);
          return bindLoopbackCallback(input);
        },
      }),
    });

    expect(outcome.kind).toBe("confirmed");
    expect(binds).toEqual([
      {
        host: "localhost",
        port: fixedPort,
        path: "/oauth/done",
        portFixedBy: "client",
      },
    ]);
    expect(calls["reconnectLoopback"]).toEqual([
      { projectId: PROJECT_ID, connectionId: "conn-1", redirectUri: supplied },
    ]);
    expect(calls["complete"]).toHaveLength(1);
  });

  test("a busy supplied redirect port says the client fixes it and starts nothing", async () => {
    const taken = await bindLoopbackCallback({
      host: "127.0.0.1",
      port: 0,
      path: "/callback",
    });
    try {
      const { api, calls } = fakeApi();
      const { reporter } = createReporterRecorder();

      const error = await rejectionOf(
        runLoopbackSignIn({
          ...baseInput,
          target: {
            kind: "reconnect",
            connectionId: "conn-1",
            suppliedRedirectUri: `http://127.0.0.1:${String(taken.port)}/callback`,
          },
          yes: true,
          reporter,
          ports: ports(api),
        }),
      );

      expect(error).toMatchObject({ code: "loopback_port_in_use" });
      expect(error.message).toContain("fixed by the client's redirect URI");
      expect(calls["reconnectLoopback"]).toBeUndefined();
    } finally {
      taken.close();
    }
  });

  test("when start names another redirect, the listener moves there before the browser opens", async () => {
    const free = await bindLoopbackCallback({
      host: "127.0.0.1",
      port: 0,
      path: "/callback",
    });
    const fixedPort = free.port;
    free.close();
    const required = `http://127.0.0.1:${String(fixedPort)}/callback`;
    const { api, calls } = fakeApi(candidateConnection(), required);
    const binds: BindLoopbackCallbackInput[] = [];
    const { reporter } = createReporterRecorder();

    const outcome = await runLoopbackSignIn({
      ...baseInput,
      yes: true,
      reporter,
      ports: ports(api, {
        bindListener: (input) => {
          binds.push(input);
          return bindLoopbackCallback(input);
        },
      }),
    });

    expect(outcome.kind).toBe("confirmed");
    expect(binds).toEqual([
      { host: "127.0.0.1", port: 0, path: "/callback" },
      {
        host: "127.0.0.1",
        port: fixedPort,
        path: "/callback",
        portFixedBy: "server",
      },
    ]);
    expect(calls["complete"]).toHaveLength(1);
  });

  test("a busy fallback port fails, says the provider fixes it, and completes nothing", async () => {
    const taken = await bindLoopbackCallback({
      host: "127.0.0.1",
      port: 0,
      path: "/callback",
    });
    try {
      const { api, calls } = fakeApi(
        candidateConnection(),
        `http://127.0.0.1:${String(taken.port)}/callback`,
      );
      const { reporter } = createReporterRecorder();

      const error = await rejectionOf(
        runLoopbackSignIn({
          ...baseInput,
          yes: true,
          reporter,
          ports: ports(api),
        }),
      );

      expect(error).toMatchObject({ code: "loopback_port_in_use" });
      expect(error.message).toContain("fixed by the provider");
      expect(calls["complete"]).toBeUndefined();
    } finally {
      taken.close();
    }
  });
});
