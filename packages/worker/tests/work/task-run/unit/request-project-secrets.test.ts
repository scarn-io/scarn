/**
 * The project-secret request against a fake Scarn API: the worker client's
 * `resolveTaskRunEnvironment` posts the claim and names, and a rejected call
 * (a stale claim's 409) surfaces as a `ProjectSecretsRequestError` naming the
 * secrets only. Also covers the run record's value-free secret sources.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { saveAuthProfile, setHomeDirForTests } from "@scarn/sdk/defaults";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { requestProjectSecrets } from "../../../../src/work/task-run/application/request-project-secrets";
import {
  ProjectSecretsRequestError,
  resolveSecretEnv,
} from "../../../../src/work/task-run/application/resolve-secret-env";
import { buildEnvironmentDiagnostics } from "../../../../src/work/task-run/contracts/environment-diagnostics";
import { createTaskPlaneWorkerClient } from "../../../../src/work/task-run/infra/worker-api-client";

const USER_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe0a1";
const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");
const claim = { task: { id: TASK_ID }, claimToken: "claim-token" };
const API_TOKEN = [
  { alg: "EdDSA" },
  { exp: Math.floor(Date.now() / 1000) + 3600 },
]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
  .concat("sig")
  .join(".");

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let requests: { path: string; body: unknown }[];
let responseStatus: number;
let responseBody: Record<string, unknown>;
let fakeHome: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/token") {
        return Response.json({ token: API_TOKEN });
      }
      requests.push({ path, body: await request.json() });
      return Response.json(responseBody, { status: responseStatus });
    },
  });
  baseUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  requests = [];
  responseStatus = 200;
  responseBody = {};
  fakeHome = mkdtempSync(join(tmpdir(), "scarn-project-secrets-"));
  setHomeDirForTests(fakeHome);
  saveAuthProfile(baseUrl, { accessToken: "token", userId: USER_ID });
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

async function createClient() {
  return await createTaskPlaneWorkerClient(baseUrl, {
    resolveUserId: () => Promise.resolve(USER_ID),
  });
}

describe("requestProjectSecrets against a fake API", () => {
  test("posts the claim and missing names, and merges the response", async () => {
    responseBody = {
      secrets: { DD_KEY: { value: "from-scarn", expiresAt: null } },
      missing: ["GONE"],
    };
    const client = await createClient();

    const result = await resolveSecretEnv({
      envVars: [
        {
          name: "DD_API_KEY",
          source: "secret",
          secretName: "DD_KEY",
          applies: "agent",
        },
        {
          name: "GONE",
          source: "secret",
          secretName: "GONE",
          applies: "agent",
        },
        {
          name: "LOCAL",
          source: "secret",
          secretName: "LOCAL",
          applies: "agent",
        },
      ],
      localEnvVars: { LOCAL: "local-value" },
      requestSecrets: (names) => requestProjectSecrets(client, claim, names),
    });

    expect(requests).toEqual([
      {
        path: `/api/task-runs/${TASK_ID}/environment`,
        body: { claimToken: "claim-token", secretNames: ["DD_KEY", "GONE"] },
      },
    ]);
    expect(result.values).toEqual({
      LOCAL: "local-value",
      DD_KEY: "from-scarn",
    });
    expect(result.sources).toEqual({ LOCAL: "worker", DD_KEY: "scarn" });
  });

  test("a stale claim (409) fails naming the secrets", async () => {
    responseStatus = 409;
    responseBody = { code: "TASK_OWNERSHIP_CONFLICT", message: "stale claim" };
    const client = await createClient();

    let error: unknown;
    try {
      await requestProjectSecrets(client, claim, ["DD_KEY"]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ProjectSecretsRequestError);
    expect((error as Error).message).toContain("DD_KEY");
    expect((error as Error).message).toContain("TASK_OWNERSHIP_CONFLICT");
  });

  test("an unreachable API fails naming the secrets", async () => {
    let error: unknown;
    try {
      await requestProjectSecrets(
        {
          resolveTaskRunEnvironment: () =>
            Promise.reject(new TypeError("fetch failed")),
        },
        claim,
        ["DD_KEY"],
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProjectSecretsRequestError);
    expect((error as Error).message).toContain("fetch failed");
  });
});

describe("environment diagnostics for secret vars", () => {
  test("lists secret:worker or secret:scarn, never a value", () => {
    const diagnostics = buildEnvironmentDiagnostics(
      {
        source: "inline",
        runtime: { kind: "host" },
        envVars: [],
        connectors: [],
      } as unknown as Parameters<typeof buildEnvironmentDiagnostics>[0],
      {
        definitionVersion: null,
        checkoutCommit: "abc",
        branch: "main",
        branches: null,
      },
      [
        { name: "A", source: "secret", secretName: "LOCAL", applies: "agent" },
        { name: "B", source: "secret", secretName: "REMOTE", applies: "both" },
      ],
      { LOCAL: "local-private-value" },
    );

    expect(diagnostics.vars).toEqual([
      { name: "A", source: "secret:worker" },
      { name: "B", source: "secret:scarn" },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("local-private-value");
  });
});
