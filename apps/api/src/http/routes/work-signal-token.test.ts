import { Elysia } from "elysia";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { getIdentityAuth } from "@scarn/identity";
import { CoreError } from "@scarn/core/lib/errors";
import { createAppContext } from "@scarn/core/lib/di";
import * as db from "@scarn/core/lib/db";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@scarn/core/organizations/organization/domain/organization-entity";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { UsageMeter } from "@scarn/core/billing/usage-meter/domain/usage-meter-entity";
import type { WorkSignalConnectionConfig } from "@scarn/core/tasks/task-run/application/work-signal";
import { apiErrorHandler } from "../error-handler";
import { createWorkSignalTokenRoutes } from "./work-signal-token";

const USER_HEADER = "x-test-user-id";
const TOKEN_SECRET = "test-work-signal-token-secret";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const REQUIRED_ENV = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
} as const;

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

const projectId = createUuidV7();
const orgId = createUuidV7();
const memberId = createUuidV7();
const outsiderId = createUuidV7();

const fakeOrgRepo = {
  findByProjectId: () =>
    Promise.resolve({ id: orgId } as unknown as OrganizationEntity),
} as unknown as OrgRepo;

const fakeUsageMeterRepo = {
  loadOrStart: (meterOrgId: UuidV7, period: string) =>
    Promise.resolve(UsageMeter.startPeriod(meterOrgId, period, "free")),
  save: (meter: UsageMeter) => Promise.resolve(meter),
} as unknown as UsageMeterRepo;

/** Grants `executions:write` on `projectId` to `memberId` only. */
const fakeUserAuthz = (actorId: UuidV7): UserAuthorizationService => ({
  actorId,
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: ({ projectId: requested }) => {
    if (requested === projectId && actorId === memberId) {
      return Promise.resolve({
        membership: null,
        isPublicNonMemberGrant: false,
      });
    }
    return Promise.reject(
      new CoreError({
        code: "PROJECT_FORBIDDEN",
        message: "You are not a member of this project",
        status: 403,
      }),
    );
  },
});

const buildApp = (workSignalConnection: WorkSignalConnectionConfig | null) =>
  new Elysia()
    .onError((context) => apiErrorHandler(context))
    .use(
      createWorkSignalTokenRoutes(
        createAppContext({
          createUserAuthorizationService: fakeUserAuthz,
          orgRepo: fakeOrgRepo,
          usageMeterRepo: fakeUsageMeterRepo,
          workSignalConnection,
          timeProvider: {
            now: () => NOW,
            nowIso: () => NOW.toISOString(),
          },
        }),
      ),
    );

const issue = (
  app: ReturnType<typeof buildApp>,
  userId: UuidV7,
  body?: { workerId: string },
) =>
  app.handle(
    new Request(`http://localhost/projects/${projectId}/work-signal-token`, {
      method: "POST",
      headers: {
        [USER_HEADER]: userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

const verifySignature = async (token: string, secret: string) => {
  const [header, payload, signature] = token.split(".") as [
    string,
    string,
    string,
  ];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
};

describe("POST /projects/:projectId/work-signal-token", () => {
  const savedEnv = new Map<string, string | undefined>();
  const configured = buildApp({
    url: "http://localhost:8787",
    tokenSecret: TOKEN_SECRET,
  });

  beforeAll(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] ??= value;
    }
  });

  afterAll(() => {
    for (const [key, value] of savedEnv) {
      restoreEnv(key, value);
    }
  });

  beforeEach(() => {
    spyOn(getIdentityAuth().api, "getSession").mockImplementation((({
      headers,
    }: {
      headers: Headers;
    }) => {
      const userId = headers.get(USER_HEADER);
      if (!userId) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        user: { id: userId, email: "worker@example.com" },
        session: { id: "session-1", userId },
      });
    }) as never);
    spyOn(db, "getDb").mockReturnValue({
      transaction: <T>(fn: (tx: never) => Promise<T>) => fn({} as never),
    } as unknown as ReturnType<typeof db.getDb>);
  });

  afterEach(() => {
    mock.restore();
  });

  test("issues a verifiable token for a project member", async () => {
    const res = await issue(configured, memberId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      token: string;
      expiresAt: string;
    };
    const exp = NOW.getTime() / 1000 + 60 * 60;
    expect(body.url).toBe("http://localhost:8787");
    expect(body.expiresAt).toBe(new Date(exp * 1000).toISOString());

    const [header, payload, signature] = body.token.split(".");
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSegment(header ?? "")).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decodeSegment(payload ?? "")).toEqual({
      pid: projectId,
      oid: orgId,
      sub: memberId,
      exp,
    });
    expect(await verifySignature(body.token, TOKEN_SECRET)).toBe(true);
    expect(await verifySignature(body.token, "wrong-secret")).toBe(false);
  });

  test("uses the given worker id as the token subject", async () => {
    const res = await issue(configured, memberId, { workerId: "laptop-1" });

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(decodeSegment(token.split(".")[1] ?? "")).toMatchObject({
      sub: "laptop-1",
    });
  });

  test("rejects a non-member with 403", async () => {
    const res = await issue(configured, outsiderId);
    expect(res.status).toBe(403);
  });

  test("rejects a request with no session with 401", async () => {
    const res = await configured.handle(
      new Request(`http://localhost/projects/${projectId}/work-signal-token`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("returns 404 when push is not configured", async () => {
    const res = await issue(buildApp(null), memberId);
    expect(res.status).toBe(404);
  });
});
