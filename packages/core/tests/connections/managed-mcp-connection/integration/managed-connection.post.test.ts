import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

/** Starting a connect on a project that already has one. */
describe("managed connection start", () => {
  const harness = createManagedConnectionHarness();
  const { fake, origin } = harness;

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("a second connect while connected returns 409 and leaves the connection ready", async () => {
    const { owner, projectId, connectionId, ready } =
      await harness.connectToReady("post-connected");

    const { error } = await harness
      .connections(projectId)
      .post(
        { preset: "notion" },
        { headers: { ...owner.authHeaders, origin } },
      );

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_STATE_CONFLICT",
    });
    expect(await harness.getConnection(owner, projectId, connectionId)).toEqual(
      ready,
    );
  });

  test("a second connect while one is in flight replaces it", async () => {
    const first = await harness.connectToCallback("post-in-flight");
    const { owner, projectId, connectionId } = first;

    const second = await harness.startConnect(owner, projectId);

    expect(second.connectionId).toBe(connectionId);
    const { location } = await harness.callback(
      first.callbackUrl,
      owner.authHeaders,
    );
    expect(location.searchParams.get("error")).toBe("invalid_callback");
    expect(fake.callsTo("token")).toHaveLength(0);
  });
});
