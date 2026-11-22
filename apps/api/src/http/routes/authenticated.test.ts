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
import { ACCESS_JWT_AUDIENCE, getIdentityAuth } from "@scarn/identity";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { AppContext } from "@scarn/core/lib/di";
import { apiErrorHandler } from "../error-handler";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { createUsernameRoutes } from "./username";
import { createTestAccessJwt } from "../../test/access-jwt";

const SESSION_USER_HEADER = "x-test-session-user";
const ISSUER = "http://localhost:3000";
const REQUIRED_ENV = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: ISSUER,
} as const;

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

const stubUserAuthz = () => ({}) as UserAuthorizationService;

const encodeSegment = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

let accessJwt: Awaited<ReturnType<typeof createTestAccessJwt>>;
const signJwt = (claims?: Record<string, unknown>) => accessJwt.sign(claims);

const jwtUser = {
  id: createUuidV7(),
  email: "jim@example.com",
  name: "Jim Halpert",
  username: "jim",
  usernameChosen: true,
};

const jwtClaimsFor = (user: typeof jwtUser) => ({
  sub: user.id,
  email: user.email,
  name: user.name,
  username: user.username,
  usernameChosen: user.usernameChosen,
});

const sessionUser = {
  id: createUuidV7(),
  email: "dwight@example.com",
  name: "Dwight Schrute",
  username: "dwight",
  usernameChosen: false,
  image: null,
};

const buildApp = () =>
  new Elysia()
    .onError((context) => apiErrorHandler(context))
    .group("/required", (app) =>
      app
        .use(createAuthenticated(stubUserAuthz))
        .get("/", ({ auth }) => ({ userId: auth.userId, user: auth.user })),
    )
    .group("/optional", (app) =>
      app
        .use(createOptionallyAuthenticated(stubUserAuthz))
        .get("/", ({ auth }) => ({ userId: auth.userId, user: auth.user })),
    );

const get = (path: string, headers?: HeadersInit) =>
  buildApp().handle(new Request(`http://localhost${path}`, { headers }));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("authenticated guards", () => {
  const savedEnv = new Map<string, string | undefined>();
  let getSession: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    accessJwt = await createTestAccessJwt(ISSUER);
  });

  afterAll(() => {
    for (const [key, value] of savedEnv) {
      restoreEnv(key, value);
    }
  });

  beforeEach(() => {
    accessJwt.mockVerifier();

    getSession = spyOn(getIdentityAuth().api, "getSession").mockImplementation(
      (({ headers }: { headers: Headers }) => {
        const authorization = headers.get("authorization");
        const cookie = headers.get("cookie");
        const known =
          headers.get(SESSION_USER_HEADER) === "1" ||
          authorization === "Bearer session-token-0123456789abcdef" ||
          cookie === "better-auth.session_token=abc";
        if (!known) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          user: sessionUser,
          session: { id: "session-1", userId: sessionUser.id },
        });
      }) as never,
    );
  });

  afterEach(() => {
    mock.restore();
  });

  test("a valid JWT resolves the user without a session lookup", async () => {
    const token = await signJwt(jwtClaimsFor(jwtUser));

    for (const path of ["/required/", "/optional/"]) {
      const res = await get(path, bearer(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: jwtUser.id, user: jwtUser });
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  test("an expired JWT is a 401 on both guards, without a session lookup", async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 60 * 60;
    const token = await signJwt({
      ...jwtClaimsFor(jwtUser),
      iat: longAgo - 15 * 60,
      exp: longAgo,
    });

    expect((await get("/required/", bearer(token))).status).toBe(401);
    expect((await get("/optional/", bearer(token))).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  test("a forged JWT is a 401 on both guards, without a session lookup", async () => {
    const valid = await signJwt(jwtClaimsFor(jwtUser));
    const [header, , signature] = valid.split(".");
    if (!header || !signature) throw new Error(`not a JWT: ${valid}`);
    const forged = `${header}.${encodeSegment({
      ...jwtClaimsFor(jwtUser),
      email: "admin@example.com",
      iss: ISSUER,
      aud: ACCESS_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.${signature}`;

    expect((await get("/required/", bearer(forged))).status).toBe(401);
    expect((await get("/optional/", bearer(forged))).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  test("a session bearer still resolves through getSession", async () => {
    const res = await get(
      "/required/",
      bearer("session-token-0123456789abcdef"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: sessionUser.id,
      user: {
        id: sessionUser.id,
        email: sessionUser.email,
        name: sessionUser.name,
        username: sessionUser.username,
        usernameChosen: false,
      },
    });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  test("a session cookie still resolves through getSession", async () => {
    const res = await get("/optional/", {
      cookie: "better-auth.session_token=abc",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: sessionUser.id });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  test("missing credentials are a 401 on the required guard", async () => {
    expect((await get("/required/")).status).toBe(401);
  });

  test("missing credentials are anonymous on the optional guard", async () => {
    const res = await get("/optional/");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: null });
  });

  test("POST /username rejects a JWT with a 401", async () => {
    const token = await signJwt(jwtClaimsFor(jwtUser));
    const app = new Elysia()
      .onError((context) => apiErrorHandler(context))
      .use(
        createUsernameRoutes({
          createUserAuthorizationService: stubUserAuthz,
        } as unknown as AppContext),
      );

    const res = await app.handle(
      new Request("http://localhost/username", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ username: "jimbo" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toContain("session");
    expect(getSession).not.toHaveBeenCalled();
  });
});
