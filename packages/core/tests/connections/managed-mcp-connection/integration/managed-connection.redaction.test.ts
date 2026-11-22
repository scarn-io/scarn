/* eslint-disable max-lines */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { acquireManagedAccessToken } from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import { getDb } from "@/lib/db";
import { CoreError } from "@/lib/errors";
import {
  managedConnectionEvents,
  managedMcpLaunchConnections,
  managedOAuthAttempts,
  managedOAuthGrants,
  secrets,
} from "@/lib/db/schema";
import { revealProjectSecrets } from "@/secrets/secret/application/reveal-project-secrets";
import { projectSecretOwner } from "@/secrets/secret/domain/secret-owner";
import {
  createSealTestClient,
  type SealRun,
} from "./managed-authority-seal-test-support";
import { createManagedConnectionHarness } from "./managed-connection-test-support";
import {
  createRelayTestClient,
  RELAY_PROTOCOL_VERSION,
  rpc,
} from "./managed-mcp-relay-test-support";

/**
 * No token, authorization code, `state` or PKCE verifier from a connect ever
 * leaves the server or lands in logs or the audit trail (decision 11), and a
 * managed connection is not a project secret (decision 1).
 */
const failureOf = async (promise: Promise<object>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};

describe("managed connection redaction", () => {
  const harness = createManagedConnectionHarness();
  const { fake, origin, logs, appContext } = harness;
  const seal = createSealTestClient(harness);
  const relayClient = createRelayTestClient(harness);

  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
  let consoleSpies: { mockRestore: () => void }[] = [];

  beforeEach(() => {
    consoleSpies = consoleMethods.map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(
          args
            .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
            .join(" "),
        );
      }),
    );
    appContext.logger.info({ probe: true }, "log capture probe");
  });

  afterEach(() => {
    for (const spy of consoleSpies) {
      spy.mockRestore();
    }
    expect(logs.some((line) => line.includes("log capture probe"))).toBe(true);
    logs.length = 0;
  });

  afterAll(async () => {
    await fake.stop();
  });

  const expectFreeOf = (label: string, text: string, canaries: string[]) => {
    for (const canary of canaries) {
      expect({ label, leaked: text.includes(canary) }).toEqual({
        label,
        leaked: false,
      });
    }
  };

  test("canary values never appear in responses, problem details, logs or events", async () => {
    const observed: { label: string; text: string }[] = [];
    const observe = (
      label: string,
      value: object | string | null | undefined,
    ) => {
      observed.push({
        label,
        text: typeof value === "string" ? value : JSON.stringify(value),
      });
    };

    const started = await harness.connectToCallback("redaction");
    const { owner, projectId, connectionId, callbackUrl } = started;
    const state = callbackUrl.searchParams.get("state") ?? "";
    const code = callbackUrl.searchParams.get("code") ?? "";
    const connection = harness.connections(projectId)({ connectionId });
    const headers = { ...owner.authHeaders, origin };

    const landed = await harness.callback(callbackUrl, owner.authHeaders);
    observe("callback location", landed.location.toString());
    observe("callback body", await landed.response.text());
    const replayed = await harness.callback(callbackUrl, owner.authHeaders);
    observe("replayed callback location", replayed.location.toString());

    const verifier = fake.callsTo("token")[0]?.params["code_verifier"] ?? "";
    const tokens = [...fake.issuedTokens];
    expect(tokens).toHaveLength(2);
    expect(state.length).toBeGreaterThan(20);
    expect(code.length).toBeGreaterThan(20);
    expect(verifier.length).toBeGreaterThan(20);
    expect(started.authorizationUrl).not.toContain(verifier);

    const pending = await harness.getConnection(owner, projectId, connectionId);
    observe("pending connection", pending);
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }

    const mismatch = await connection.candidate.confirm.post(
      {
        candidateId: candidate.id,
        fingerprint: "0".repeat(candidate.fingerprint.length),
        expectedVersion: pending.version,
      },
      { headers },
    );
    observe("mismatch problem", mismatch.error?.value);
    const invalid = await connection.candidate.confirm.post(
      // @ts-expect-error -- deliberately malformed body
      { candidateId: code, fingerprint: state, expectedVersion: verifier },
      { headers },
    );
    expect(invalid.error?.status).toBe(422);
    observe("validation problem", invalid.error?.value);

    const confirmed = await connection.candidate.confirm.post(
      {
        candidateId: candidate.id,
        fingerprint: candidate.fingerprint,
        expectedVersion: pending.version,
      },
      { headers },
    );
    expect(confirmed.data?.state).toBe("ready");
    observe("confirmed connection", confirmed.data);
    const conflict = await harness
      .connections(projectId)
      .post({ preset: "notion" }, { headers });
    expect(conflict.error?.status).toBe(409);
    observe("conflict problem", conflict.error?.value);
    const listed = await harness
      .connections(projectId)
      .get({ headers: owner.authHeaders });
    observe("list", listed.data);
    const disconnected = await connection.delete(undefined, { headers });
    expect(disconnected.data?.revocation).toBe("accepted");
    observe("disconnect response", disconnected.data);
    expect(fake.callsTo("revoke")[0]?.params["token"]).toBe(tokens[1]);

    const events = await getDb()
      .select()
      .from(managedConnectionEvents)
      .where(eq(managedConnectionEvents.connectionId, connectionId));
    const eventTypes = events.map((event) => event.type);
    for (const type of [
      "connect_started",
      "candidate_attached",
      "candidate_confirmed",
      "disconnected",
      "revocation_attempted",
    ] as const) {
      expect(eventTypes).toContain(type);
    }
    observe("events", events);
    const storedRows = [
      ...(await getDb()
        .select()
        .from(managedOAuthGrants)
        .where(eq(managedOAuthGrants.connectionId, connectionId))),
      ...(await getDb()
        .select()
        .from(managedOAuthAttempts)
        .where(eq(managedOAuthAttempts.connectionId, connectionId))),
    ];
    observe(
      "stored rows",
      storedRows.map((row) =>
        Object.values(row)
          .map((value) =>
            Buffer.isBuffer(value) ? value.toString("latin1") : String(value),
          )
          .join("\n"),
      ),
    );
    observe("logs", logs.join("\n"));

    for (const { label, text } of observed) {
      expectFreeOf(label, text, [...tokens, code, state, verifier]);
    }
  });

  test("a failed exchange's problem details and logs carry only a code", async () => {
    const { owner, projectId, connectionId, callbackUrl } =
      await harness.connectToCallback("redaction-failed");
    fake.faults.token = "invalid_client";
    const state = callbackUrl.searchParams.get("state") ?? "";
    const code = callbackUrl.searchParams.get("code") ?? "";
    const logsBefore = logs.length;

    const { location, response } = await harness.callback(
      callbackUrl,
      owner.authHeaders,
    );
    fake.faults = {};

    expect(location.searchParams.get("error")).not.toBeNull();
    const verifier =
      fake.callsTo("token").at(-1)?.params["code_verifier"] ?? "";
    expect(verifier.length).toBeGreaterThan(20);
    const events = await getDb()
      .select()
      .from(managedConnectionEvents)
      .where(eq(managedConnectionEvents.connectionId, connectionId));
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    for (const [label, text] of [
      ["location", location.toString()],
      ["body", await response.text()],
      ["connection", JSON.stringify(connection)],
      ["events", JSON.stringify(events)],
      ["logs", logs.slice(logsBefore).join("\n")],
    ] as const) {
      expectFreeOf(label, text, [code, state, verifier]);
    }
  });

  test("tokens from refresh responses never appear in responses, logs, events or stored rows", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("redaction-refresh");
    const input = {
      projectId: parseUuidV7(projectId),
      connectionId: parseUuidV7(connectionId),
    };
    const issuedBefore = fake.issuedTokens.length;
    const logsBefore = logs.length;

    try {
      harness.clock.advance(60 * 60 * 1000);
      const refreshed = await acquireManagedAccessToken(input, appContext);
      const refreshTokens = fake.issuedTokens.slice(issuedBefore);
      expect(refreshTokens).toHaveLength(2);
      expect(refreshed.accessToken).toBe(refreshTokens[0] ?? "");

      harness.clock.advance(60 * 60 * 1000);
      fake.faults.refresh = "server_error";
      const failed = await failureOf(
        acquireManagedAccessToken(input, appContext),
      );
      expect(failed).toMatchObject({ code: "MANAGED_CONNECTION_NOT_READY" });
      expect(fake.callsTo("refresh").at(-1)?.params["refresh_token"]).toBe(
        refreshTokens[1],
      );

      const connection = await harness.getConnection(
        owner,
        projectId,
        connectionId,
      );
      expect(connection.state).toBe("reconnect_required");
      const events = await getDb()
        .select()
        .from(managedConnectionEvents)
        .where(eq(managedConnectionEvents.connectionId, connectionId));
      expect(events.map((event) => event.type)).toContain("refresh_succeeded");
      expect(events.map((event) => event.type)).toContain("refresh_failed");
      const grants = await getDb()
        .select()
        .from(managedOAuthGrants)
        .where(eq(managedOAuthGrants.connectionId, connectionId));
      for (const [label, text] of [
        ["connection", JSON.stringify(connection)],
        [
          "error",
          JSON.stringify({
            message: failed.message,
            meta: failed instanceof CoreError ? failed.meta : null,
          }),
        ],
        ["events", JSON.stringify(events)],
        [
          "stored rows",
          grants
            .flatMap((row) =>
              Object.values(row).map((value) =>
                Buffer.isBuffer(value)
                  ? value.toString("latin1")
                  : String(value),
              ),
            )
            .join("\n"),
        ],
        ["logs", logs.slice(logsBefore).join("\n")],
      ] as const) {
        expectFreeOf(label, text, refreshTokens);
      }
    } finally {
      fake.faults = {};
      harness.clock.reset();
    }
  });

  test("relayed calls, refreshes and the seal never put a token or the relay capability in logs, events, responses or stored rows", async () => {
    const target = await seal.project("redaction-relay");
    const issuedBefore = fake.issuedTokens.length;
    const logsBefore = logs.length;
    harness.clock.advance(60 * 60 * 1000);
    const run = await seal.launchRun(target);
    const lost = await seal.launchRun(target);
    const observed: { label: string; text: string }[] = [];
    const observeResponse = async (label: string, response: Response) => {
      observed.push({
        label,
        text: `${String(response.status)} ${JSON.stringify([...response.headers])} ${await response.text()}`,
      });
    };
    const call = (on: SealRun, id: number, method: string, params = {}) =>
      relayClient.relay(on, { body: rpc(id, method, params) });

    try {
      await observeResponse(
        "initialize",
        await call(run, 1, "initialize", {
          protocolVersion: RELAY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "redaction", version: "0" },
        }),
      );
      await observeResponse("tools/list", await call(run, 2, "tools/list"));
      fake.faults.mcp = "mcp_unauthorized_once";
      await observeResponse(
        "tools/call after refresh",
        await call(run, 3, "tools/call", {
          name: "notion-tool-0-0",
          arguments: {},
        }),
      );
      fake.faults.mcp = "mcp_server_error";
      await observeResponse("provider error", await call(run, 4, "tools/list"));
      fake.faults = {};
      await harness.settleBackgroundTasks();
      expect(fake.refreshCount).toBeGreaterThanOrEqual(2);
      observed.push({
        label: "completion",
        text: JSON.stringify(await seal.complete(target, run)),
      });

      await seal.disconnect(target);
      await observeResponse(
        "refused after disconnect",
        await call(lost, 1, "tools/list"),
      );
      observed.push({
        label: "failed completion",
        text: JSON.stringify(await seal.complete(target, lost)),
      });

      const tokens = fake.issuedTokens.slice(0);
      expect(fake.issuedTokens.length - issuedBefore).toBeGreaterThanOrEqual(2);
      const events = await getDb()
        .select()
        .from(managedConnectionEvents)
        .where(eq(managedConnectionEvents.connectionId, target.connectionId));
      expect(events.map((event) => event.type)).toContain("authority_lost");
      const launches = await getDb()
        .select()
        .from(managedMcpLaunchConnections)
        .where(
          eq(managedMcpLaunchConnections.connectionId, target.connectionId),
        );
      const runs = await Promise.all(
        [run, lost].map(async ({ taskRunId }) =>
          JSON.stringify(
            await harness.apiClient.api["task-runs"]({ taskRunId }).get({
              headers: target.owner.authHeaders,
            }),
          ),
        ),
      );
      const rowText = (rows: object[]) =>
        rows
          .flatMap((row) =>
            Object.values(row).map((value) =>
              Buffer.isBuffer(value) ? value.toString("latin1") : String(value),
            ),
          )
          .join("\n");
      const capabilities = [run.capability, lost.capability];

      for (const { label, text } of [
        ...observed,
        { label: "events", text: JSON.stringify(events) },
        { label: "launch rows", text: rowText(launches) },
        { label: "runs", text: runs.join("\n") },
        { label: "logs", text: logs.slice(logsBefore).join("\n") },
      ]) {
        expectFreeOf(label, text, [...tokens, ...capabilities]);
      }
    } finally {
      fake.faults = {};
      harness.clock.reset();
    }
  });

  test("a connection creates no secret and revealProjectSecrets can't see it", async () => {
    const { projectId, connectionId } =
      await harness.connectToReady("redaction-secrets");

    const rows = await getDb()
      .select({ id: secrets.id })
      .from(secrets)
      .where(eq(secrets.ownerProjectId, projectId));
    expect(rows).toEqual([]);
    expect(
      await appContext.secretRepo.listByOwner(projectSecretOwner(projectId)),
    ).toEqual([]);
    const names = ["notion", "NOTION", "Notion", connectionId];
    const revealed = await revealProjectSecrets(projectId, names, {
      secretRepo: appContext.secretRepo,
      secretCipher: appContext.secretCipher,
      timeProvider: appContext.timeProvider,
    });
    expect(revealed.values.size).toBe(0);
    expect(revealed.missing).toEqual(names);
  });
});
