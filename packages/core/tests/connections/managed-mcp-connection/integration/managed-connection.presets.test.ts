import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import {
  addWriteMember,
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { FAKE_PRESET_KEY } from "./managed-connection-fake-presets";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

/**
 * Creating connections from presets. The harness catalog adds
 * {@link FAKE_PRESET_KEY}, whose server is the loopback fake and which has no
 * removal URL; the harness's seeded `notion` connection points at the same
 * fake.
 */
describe("managed connections from presets", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, fake, origin } = harness;

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const newProject = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    return { owner, projectId };
  };

  const start = (
    owner: ProjectSecretsTestUser,
    projectId: UuidV7,
    body: { preset: string; name?: string },
  ) =>
    harness
      .connections(projectId)
      .post(body, { headers: { ...owner.authHeaders, origin } });

  test("starting from a preset names the connection after it and fills in its server", async () => {
    const { owner, projectId } = await newProject("preset-default-name");

    const started = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY }),
    );

    expect(new URL(started.authorizationUrl).origin).toBe(fake.origin);
    const connection = await harness.getConnection(
      owner,
      projectId,
      started.connectionId,
    );
    expect(connection).toMatchObject({
      name: FAKE_PRESET_KEY,
      label: "Fake Docs",
      preset: FAKE_PRESET_KEY,
      resource: fake.resource,
      state: "connecting",
    });
  });

  test("an explicit name is used instead of the preset key", async () => {
    const { owner, projectId } = await newProject("preset-explicit-name");

    const started = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY, name: "team-docs" }),
    );

    expect(
      await harness.getConnection(owner, projectId, started.connectionId),
    ).toMatchObject({ name: "team-docs", preset: FAKE_PRESET_KEY });
  });

  test("an unknown preset is 422 and creates nothing", async () => {
    const { owner, projectId } = await newProject("preset-unknown");

    const { error } = await start(owner, projectId, { preset: "acme" });

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_PRESET_UNKNOWN",
    });
    expect(
      await unwrapAsync(
        harness.connections(projectId).get({ headers: owner.authHeaders }),
      ),
    ).toEqual([]);
  });

  test.each([["Team Docs"], ["-docs"], [""], ["a".repeat(64)]])(
    "an invalid name %p is 422",
    async (name) => {
      const { owner, projectId } = await newProject("preset-bad-name");

      const { error } = await start(owner, projectId, {
        preset: FAKE_PRESET_KEY,
        name,
      });

      expect(error?.status).toBe(422);
    },
  );

  test("a name taken by a connection from another preset is 409", async () => {
    const { owner, projectId } = await newProject("preset-name-taken");
    const existing = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY }),
    );

    const { error } = await start(owner, projectId, {
      preset: "notion",
      name: FAKE_PRESET_KEY,
    });

    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "MANAGED_CONNECTION_EXISTS" });
    const listed = await unwrapAsync(
      harness.connections(projectId).get({ headers: owner.authHeaders }),
    );
    expect(listed.map(({ id, preset }) => ({ id, preset }))).toEqual([
      { id: existing.connectionId, preset: FAKE_PRESET_KEY },
    ]);
  });

  test("an MCP URL another connection already uses is 409 under any other name", async () => {
    const { owner, projectId } = await newProject("preset-resource-taken");
    await harness.seedFakeConnection(projectId);

    for (const body of [
      { preset: FAKE_PRESET_KEY },
      { preset: FAKE_PRESET_KEY, name: "other-docs" },
    ]) {
      const { error } = await start(owner, projectId, body);

      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "MANAGED_CONNECTION_EXISTS" });
      expect(JSON.stringify(error?.value)).toContain('\\"notion\\"');
    }
    expect(fake.callsTo("protected_resource_metadata")).toHaveLength(0);
  });

  test("starting the same connection again reuses it, in flight or disconnected", async () => {
    const { owner, projectId } = await newProject("preset-restart");
    const first = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY }),
    );

    const again = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY }),
    );
    expect(again.connectionId).toBe(first.connectionId);

    await harness.disconnect(owner, projectId, first.connectionId);
    const afterDisconnect = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY }),
    );
    expect(afterDisconnect.connectionId).toBe(first.connectionId);
  });

  test("a member without secrets:write can't start one, even with an unknown preset", async () => {
    const { owner, projectId } = await newProject("preset-forbidden-owner");
    const writer = await createProjectSecretsTestUser("preset-forbidden");
    await addWriteMember(apiClient, projectId, owner, writer);

    for (const preset of [FAKE_PRESET_KEY, "acme"]) {
      const { error } = await start(writer, projectId, { preset });
      expect(error?.status).toBe(403);
    }
  });

  test("disconnecting reports the preset's removal URL, or null when it has none", async () => {
    const { owner, projectId } = await newProject("preset-removal-url");
    const started = await unwrapAsync(
      start(owner, projectId, { preset: FAKE_PRESET_KEY }),
    );

    const response = await harness.disconnect(
      owner,
      projectId,
      started.connectionId,
    );

    expect(response.providerRemovalUrl).toBeNull();
  });

  describe("the preset list", () => {
    const presetsOf = (user: ProjectSecretsTestUser, projectId: UuidV7) =>
      apiClient.api
        .projects({ projectId })
        ["mcp-connection-presets"].get({ headers: user.authHeaders });

    test("lists every preset with its normalized MCP URL and removal page", async () => {
      const { owner, projectId } = await newProject("presets-list");

      expect(await unwrapAsync(presetsOf(owner, projectId))).toEqual([
        {
          key: "notion",
          label: "Notion",
          resource: "https://mcp.notion.com/mcp",
          removalUrl: "https://www.notion.so/profile/integrations",
        },
        {
          key: "cloudflare-observability",
          label: "Cloudflare Observability",
          resource: "https://observability.mcp.cloudflare.com/mcp",
          removalUrl: null,
        },
        {
          key: "linear",
          label: "Linear",
          resource: "https://mcp.linear.app/mcp",
          removalUrl: null,
        },
        {
          key: "sentry",
          label: "Sentry",
          resource: "https://mcp.sentry.dev/mcp",
          removalUrl: null,
        },
        {
          key: "neon",
          label: "Neon",
          resource: "https://mcp.neon.tech/mcp",
          removalUrl: null,
        },
        {
          key: "posthog",
          label: "PostHog",
          resource: "https://mcp.posthog.com/mcp",
          removalUrl: null,
        },
        {
          key: "stripe",
          label: "Stripe",
          resource: "https://mcp.stripe.com",
          removalUrl: null,
        },
        {
          key: "netlify",
          label: "Netlify",
          resource: "https://netlify-mcp.netlify.app/mcp",
          removalUrl: null,
        },
        {
          key: FAKE_PRESET_KEY,
          label: "Fake Docs",
          resource: fake.resource,
          removalUrl: null,
        },
      ]);
    });

    test("any member can read it; anyone else gets 404", async () => {
      const { owner, projectId } = await newProject("presets-members");
      const writer = await createProjectSecretsTestUser("presets-reader");
      await addWriteMember(apiClient, projectId, owner, writer);
      const stranger = await createProjectSecretsTestUser("presets-stranger");

      expect(await unwrapAsync(presetsOf(writer, projectId))).toHaveLength(9);
      expect((await presetsOf(stranger, projectId)).error?.status).toBe(404);
    });
  });
});

/** A connection without a preset has no removal page to point at. */
describe("managed connection without a preset", () => {
  const harness = createManagedConnectionHarness({ preset: null });

  afterAll(async () => {
    await harness.fake.stop();
  });

  test("disconnecting reports a null removal URL", async () => {
    const { owner, projectId, connectionId } = await harness.connectToCallback(
      "no-preset-removal-url",
    );

    const response = await harness.disconnect(owner, projectId, connectionId);

    expect(response.connection.preset).toBeNull();
    expect(response.providerRemovalUrl).toBeNull();
  });
});
