import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { DrizzleAuthUserRepo } from "@scarn/identity";
import { createTestUserAndSession } from "@scarn/identity/testing";
import { createAppContext } from "@/lib/di";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest } from "tests/utils";

/**
 * Integration coverage for `POST /api/username`.
 *
 * The endpoint delegates its write to Better Auth's `auth.api.updateUser`
 * instead of writing `authUsers` directly, purely so the `session.cookieCache`
 * snapshot is re-signed in the same response that changes the row. The
 * load-bearing assertions here are therefore about the `Set-Cookie` headers:
 * if they do not survive the trip out through Elysia, the snapshot silently
 * goes stale and every reader has to keep opting out of the cache.
 *
 * These tests live under `packages/core/tests` because that is the only
 * workspace with a harness that boots the real Elysia app (`createApp`) against
 * a container-backed Postgres carrying BOTH the core and identity migrations.
 * `apps/api` has no DB-backed test harness.
 */

const SESSION_DATA_COOKIE = "better-auth.session_data";
const SESSION_TOKEN_COOKIE = "better-auth.session_token";
const ORIGIN = "http://localhost";

/**
 * Merge `Set-Cookie` values into a cookie jar the way a browser would: last
 * write per name wins, and a cleared cookie (empty value) is dropped. Values are
 * carried over VERBATIM — Better Auth already percent-encoded them, and
 * re-encoding would break the snapshot's HMAC and silently downgrade a cached
 * read into a database read, which would make the test below vacuous.
 */
const applySetCookies = (
  jar: Map<string, string>,
  setCookies: readonly string[],
): Map<string, string> => {
  for (const entry of setCookies) {
    const pair = entry.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value.length === 0) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }

  return jar;
};

const serializeJar = (jar: Map<string, string>): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

const uniqueUsername = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

const uniqueEmail = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID()}@example.com`;

type SnapshotUser = { username: unknown; usernameChosen: unknown };

/**
 * Decode the `session_data` cookie-cache payload. With the default "compact"
 * strategy the value is base64url(JSON) of `{ session, expiresAt, signature }`,
 * where the inner `session` is itself `{ session, user, updatedAt, version }`.
 * We only read it to prove the snapshot was rebuilt from the fresh row — the
 * HMAC is Better Auth's business, not this test's.
 *
 * Better Auth can emit the snapshot more than once in one response (the
 * session lookup re-caches the old row before `updateUser` writes the new
 * one), so the LAST entry is read — the one a browser would keep.
 */
const decodeSnapshotUser = (setCookies: readonly string[]): SnapshotUser => {
  const entry = setCookies
    .filter((cookie) => cookie.startsWith(`${SESSION_DATA_COOKIE}=`))
    .at(-1);
  if (!entry) {
    throw new Error(
      `No ${SESSION_DATA_COOKIE} cookie in: ${JSON.stringify(setCookies)}`,
    );
  }

  const value = entry.slice(`${SESSION_DATA_COOKIE}=`.length).split(";")[0] ?? "";
  const decoded: unknown = JSON.parse(
    Buffer.from(decodeURIComponent(value), "base64url").toString("utf8"),
  );
  const snapshot = (decoded as { session?: { user?: SnapshotUser } }).session
    ?.user;
  if (!snapshot) {
    throw new Error("Cookie-cache payload had no session.user");
  }

  return snapshot;
};

describe("username post endpoint", () => {
  const analytics = new RecordingAnalytics();
  const app = createApp(createAppContext({ analytics }));

  concurrentTest(
    "reports username_chosen on the first pick but not on a later rename",
    async () => {
      const apiClient = createScarnTreaty(app);
      const user = await createTestUserAndSession({
        email: uniqueEmail("analytics-pick"),
        username: null,
      });
      const callsForUser = () =>
        analytics
          .callsFor("username_chosen")
          .filter((call) => call.distinctId === user.userId);

      const first = await apiClient.api.username.post(
        { username: uniqueUsername("first") },
        { headers: { ...user.authHeaders } },
      );
      expect(first.error).toBeNull();
      expect(callsForUser()).toEqual([
        { distinctId: user.userId, event: "username_chosen", properties: {} },
      ]);

      const rename = await apiClient.api.username.post(
        { username: uniqueUsername("rename") },
        { headers: { ...user.authHeaders } },
      );
      expect(rename.error).toBeNull();
      expect(callsForUser()).toHaveLength(1);
    },
  );

  concurrentTest(
    "sets the username, marks onboarding complete, and returns the user contract",
    async () => {
      const apiClient = createScarnTreaty(app);
      const user = await createTestUserAndSession({
        email: uniqueEmail("set-username"),
        username: null,
      });
      const chosen = uniqueUsername("chosen");

      const { data, error } = await apiClient.api.username.post(
        { username: chosen },
        { headers: { ...user.authHeaders } },
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({
        id: user.userId,
        username: chosen,
        // Proves the `user.update.before` hook in @scarn/identity fires
        // through this path — the route never sends `usernameChosen` itself.
        usernameChosen: true,
      });

      const row = await new DrizzleAuthUserRepo().load(user.userId);
      expect(row?.username).toBe(chosen);
      expect(row?.usernameChosen).toBe(true);
    },
  );

  concurrentTest(
    "refreshes the session cookie-cache snapshot via Set-Cookie",
    async () => {
      const apiClient = createScarnTreaty(app);
      const user = await createTestUserAndSession({
        email: uniqueEmail("cookie-refresh"),
        username: null,
      });
      const chosen = uniqueUsername("cookie");

      const { error, response } = await apiClient.api.username.post(
        { username: chosen },
        { headers: { ...user.authHeaders } },
      );
      expect(error).toBeNull();

      // Better Auth emits more than one cookie (session token + snapshot), so a
      // single-valued `set-cookie` assignment would have dropped one of them.
      const setCookies = response.headers.getSetCookie();
      expect(setCookies.length).toBeGreaterThan(1);
      expect(
        setCookies.some((cookie) => cookie.startsWith("better-auth.session_token=")),
      ).toBe(true);

      const snapshot = decodeSnapshotUser(setCookies);
      expect(snapshot.username).toBe(chosen);
      expect(snapshot.usernameChosen).toBe(true);
    },
  );

  // The property that lets `getServerSession()` in apps/next read THROUGH the
  // cookie cache (no `disableCookieCache`): after a username change, a
  // cache-allowed read reports the NEW handle. The onboarding gate in
  // `(protected)/layout.tsx` branches on exactly these fields, so a stale read
  // here is what used to strand a just-onboarded user in a redirect loop.
  //
  // The jar is primed with a snapshot of the OLD row FIRST, which is what gives
  // this test teeth: if the route ever goes back to writing the row directly, it
  // emits no `Set-Cookie`, the stale snapshot survives step 2, and step 3 reports
  // the old handle instead of quietly falling back to a database read.
  concurrentTest(
    "a cache-allowed get-session after a rename reports the new username",
    async () => {
      const apiClient = createScarnTreaty(app);
      const before = uniqueUsername("stale-before");
      const user = await createTestUserAndSession({
        email: uniqueEmail("stale-read"),
        username: before,
        // Inside `session.updateAge` of expiry, so the priming read below also
        // refreshes the session and hands back the signed `session_token` cookie
        // alongside the snapshot — the exact pair a browser would hold.
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      });

      const primed = await app.handle(
        new Request(`${ORIGIN}/api/auth/get-session`, {
          headers: { ...user.authHeaders, origin: ORIGIN },
        }),
      );
      expect(primed.status).toBe(200);

      const primedCookies = primed.headers.getSetCookie();
      expect(decodeSnapshotUser(primedCookies).username).toBe(before);
      const jar = applySetCookies(new Map(), primedCookies);
      expect(jar.has(SESSION_TOKEN_COOKIE)).toBe(true);

      const renamed = uniqueUsername("stale-after");
      const { error, response } = await apiClient.api.username.post(
        { username: renamed },
        { headers: { cookie: serializeJar(jar) } },
      );
      expect(error).toBeNull();
      applySetCookies(jar, response.headers.getSetCookie());

      // The read `getServerSession()` performs: cookie cache ALLOWED.
      const cached = await app.handle(
        new Request(`${ORIGIN}/api/auth/get-session`, {
          headers: { cookie: serializeJar(jar), origin: ORIGIN },
        }),
      );
      expect(cached.status).toBe(200);

      const body: unknown = await cached.json();
      expect((body as { user?: SnapshotUser } | null)?.user).toMatchObject({
        username: renamed,
        usernameChosen: true,
      });
    },
  );

  concurrentTest(
    "returns 409 when another user already holds the username",
    async () => {
      const apiClient = createScarnTreaty(app);
      const taken = uniqueUsername("taken");
      await createTestUserAndSession({
        email: uniqueEmail("holder"),
        username: taken,
      });
      const claimant = await createTestUserAndSession({
        email: uniqueEmail("claimant"),
        username: null,
      });

      const { data, error } = await apiClient.api.username.post(
        { username: taken },
        { headers: { ...claimant.authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ status: 409, code: "USERNAME_TAKEN" });

      const row = await new DrizzleAuthUserRepo().load(claimant.userId);
      expect(row?.username).toBeNull();
      expect(row?.usernameChosen).toBe(false);
    },
  );

  concurrentTest(
    "lets exactly one of two simultaneous claims win, and 409s the loser",
    async () => {
      const apiClient = createScarnTreaty(app);
      const contested = uniqueUsername("contested");
      const [first, second] = await Promise.all([
        createTestUserAndSession({
          email: uniqueEmail("racer-a"),
          username: null,
        }),
        createTestUserAndSession({
          email: uniqueEmail("racer-b"),
          username: null,
        }),
      ]);

      // Whichever claim loses may lose at the `isUsernameTaken` pre-check OR at
      // the partial unique index (`identity_user_username_unique`) inside
      // `updateUser`. Both paths must surface the same 409 — the index path is
      // the one that only works because `isUniqueViolation` unwraps `cause`.
      const results = await Promise.all(
        [first, second].map((racer) =>
          apiClient.api.username.post(
            { username: contested },
            { headers: { ...racer.authHeaders } },
          ),
        ),
      );

      const statuses = results.map((result) => result.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(
        results.find((result) => result.status === 409)?.error?.value,
      ).toMatchObject({ code: "USERNAME_TAKEN" });
      expect(results.find((result) => result.status === 200)?.data).toMatchObject(
        { username: contested, usernameChosen: true },
      );
    },
  );

  concurrentTest("rejects a reserved username", async () => {
    const apiClient = createScarnTreaty(app);
    const user = await createTestUserAndSession({
      email: uniqueEmail("reserved"),
      username: null,
    });

    const { data, error } = await apiClient.api.username.post(
      { username: "admin" },
      { headers: { ...user.authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);

    const row = await new DrizzleAuthUserRepo().load(user.userId);
    expect(row?.username).toBeNull();
  });

  concurrentTest("rejects a malformed username", async () => {
    const apiClient = createScarnTreaty(app);
    const user = await createTestUserAndSession({
      email: uniqueEmail("malformed"),
      username: null,
    });

    const { data, error } = await apiClient.api.username.post(
      { username: "--bad--" },
      { headers: { ...user.authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);

    const row = await new DrizzleAuthUserRepo().load(user.userId);
    expect(row?.username).toBeNull();
  });
});
