/**
 * A step's `ref` or `remote` MCP server may name the project's managed
 * connection in `auth`. Saving and publishing never look the connection up
 * (decision 11), so they check only shape: a valid connection name, and an
 * inline `remote` with `auth` has a usable resource URL with nothing else
 * authenticating it.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { defineMcp, defineStep } from "@scarn/sdk";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { acquireManagedAccessToken } from "@/connections/managed-mcp-connection/application/acquire-managed-access-token";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { getDb } from "@/lib/db";
import { stepDefinitions } from "@/lib/db/schema";
import { createManagedConnectionHarness } from "tests/connections/managed-mcp-connection/integration/managed-connection-test-support";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import {
  createPipelineFromDocument,
  singleStepPipelineDocument,
} from "../../pipeline-test-support";
import {
  environmentContent,
  uniqueEnvironmentName,
} from "../../environment/integration/environment-test-support";

const NOTION_RESOURCE = MANAGED_CONNECTION_PRESETS.notion.resource;
const HOUR_MS = 60 * 60 * 1000;

describe("step definition MCP connection auth", () => {
  const harness = createManagedConnectionHarness();
  const { apiClient, fake, clock, appContext } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const newProject = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    return { projectId, headers: owner.authHeaders };
  };

  const stepPayload = (
    projectId: UuidV7,
    opencodeMcpJson: Record<string, unknown>,
    key = `mcp_auth_${crypto.randomUUID()}`,
  ) => ({
    projectId,
    key,
    name: "MCP connection auth",
    description: null,
    prompt: "Use Notion.",
    version: 1,
    kind: "user_defined" as const,
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    status: "active" as const,
    opencodeMcpJson: opencodeMcpJson as never,
  });

  const configIdOf = async (stepDefinitionId: string) => {
    const [row] = await getDb()
      .select({ taskExecutionConfigId: stepDefinitions.taskExecutionConfigId })
      .from(stepDefinitions)
      .where(eq(stepDefinitions.id, stepDefinitionId));
    return row?.taskExecutionConfigId;
  };

  const publish = async (
    projectId: UuidV7,
    headers: { authorization: string },
    stepKey: string,
  ) =>
    await createPipelineFromDocument(
      apiClient,
      headers,
      projectId,
      singleStepPipelineDocument(`mcp-auth-${crypto.randomUUID()}`, stepKey),
    );

  const authedConfigs = {
    ref: {
      notion: { type: "ref", auth: { connection: "notion" } },
    },
    remote: {
      notion: {
        type: "remote",
        url: NOTION_RESOURCE,
        auth: { connection: "notion" },
        codemode: true,
      },
    },
    "non-preset remote": {
      docs: {
        type: "remote",
        url: "https://docs.acme.test/mcp",
        auth: { connection: "acme-docs" },
      },
    },
  } as const;

  for (const [type, opencodeMcpJson] of Object.entries(authedConfigs)) {
    test(`a ${type} entry with auth reads back unchanged on create, update and get`, async () => {
      const { projectId, headers } = await newProject(`mcp-auth-${type}`);
      const payload = stepPayload(projectId, opencodeMcpJson);

      const created = await unwrapAsync(
        apiClient.api["step-definitions"].post(payload, { headers }),
      );
      expect(created.opencodeMcpJson).toEqual(opencodeMcpJson);

      const updated = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          { ...payload, prompt: "Use Notion again." },
          { headers },
        ),
      );
      expect(updated.id).toBe(created.id);
      expect(updated.opencodeMcpJson).toEqual(opencodeMcpJson);

      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({
          stepDefinitionId: created.id,
        }).get({ headers }),
      );
      expect(reloaded.opencodeMcpJson).toEqual(opencodeMcpJson);
    });

    test(`two steps with the same ${type} auth config share one row`, async () => {
      const { projectId, headers } = await newProject(`mcp-auth-dedup-${type}`);

      const a = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          stepPayload(projectId, opencodeMcpJson),
          { headers },
        ),
      );
      const b = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          stepPayload(projectId, opencodeMcpJson),
          { headers },
        ),
      );

      const first = await configIdOf(a.id);
      expect(first).toBeTruthy();
      expect(await configIdOf(b.id)).toBe(first);
    });
  }

  const resourceMessage =
    "must be an absolute http(s) URL with no query string, fragment or credentials";
  const absentMessage = "must be absent when auth is set";
  const rejectedRemotes = {
    "an invalid connection name": [
      {
        type: "remote",
        url: NOTION_RESOURCE,
        auth: { connection: "Notion" },
      },
      "kebab-case",
    ],
    "a url with a query string": [
      {
        type: "remote",
        url: `${NOTION_RESOURCE}?workspace=1`,
        auth: { connection: "notion" },
      },
      resourceMessage,
    ],
    headers: [
      {
        type: "remote",
        url: NOTION_RESOURCE,
        auth: { connection: "notion" },
        headers: { Authorization: "Bearer {env:NOTION_TOKEN}" },
      },
      absentMessage,
    ],
    oauth: [
      {
        type: "remote",
        url: NOTION_RESOURCE,
        auth: { connection: "notion" },
        oauth: false,
      },
      absentMessage,
    ],
  } as const;

  for (const [label, [server, message]] of Object.entries(rejectedRemotes)) {
    test(`an inline remote with auth and ${label} is rejected`, async () => {
      const { projectId, headers } = await newProject("mcp-auth-rejected");

      const { data, error } = await apiClient.api["step-definitions"].put(
        stepPayload(projectId, { notion: server }),
        { headers },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(JSON.stringify(error?.value)).toContain(message);
    });
  }

  const publishesWith = async (
    projectId: UuidV7,
    headers: { authorization: string },
    type: "ref" | "remote" = "remote",
  ) => {
    const spec = defineStep({
      key: `mcp_auth_${crypto.randomUUID()}`,
      name: "Auth check",
      agentPrompt: "Read Notion docs.",
      mcps: {
        docs: defineMcp({
          ...(type === "remote"
            ? { type: "remote" as const, url: NOTION_RESOURCE }
            : { type: "ref" as const }),
          name: "notion",
          auth: { connection: "notion" },
          healthChecks: {
            search: { tool: "notion_search", args: { query: "docs" } },
          },
        }),
      },
    });
    const step = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        {
          ...stepPayload(projectId, spec.opencodeMcpJson ?? {}, spec.key),
          healthChecksJson: spec.healthChecksJson,
        },
        { headers },
      ),
    );
    expect(step.opencodeMcpJson).toEqual(spec.opencodeMcpJson);
    expect(step.healthChecksJson).toMatchObject([
      {
        kind: "tool",
        name: "docs.search",
        mcp: "docs",
        tool: "notion_search",
        args: { query: "docs" },
      },
    ]);
    const pipeline = await publish(projectId, headers, step.key);
    expect(pipeline.id).toBeTruthy();
  };

  for (const type of ["ref", "remote"] as const) {
    test(`publishing a ${type} with an auth check succeeds without a Notion connection`, async () => {
      const { projectId, headers } = await newProject("mcp-auth-no-connection");

      await publishesWith(projectId, headers, type);
    });
  }

  test("publishing with an auth check succeeds when the project's Notion connection is ready", async () => {
    const { owner, projectId } = await harness.connectToReady(
      "mcp-auth-ready-connection",
    );

    await publishesWith(projectId, owner.authHeaders);
  });

  test("publishing with an auth check succeeds when the project's Notion connection needs reconnecting", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "mcp-auth-reconnect-connection",
    );
    clock.advance(HOUR_MS);
    fake.faults.refresh = "invalid_grant";
    await acquireManagedAccessToken(
      {
        projectId: parseUuidV7(projectId),
        connectionId: parseUuidV7(connectionId),
      },
      appContext,
    ).catch(() => undefined);
    const connection = await harness.getConnection(
      owner,
      projectId,
      connectionId,
    );
    expect(connection.state).toBe("reconnect_required");

    await publishesWith(projectId, owner.authHeaders);
  });

  test("a step key that equals a named environment's connector id is rejected", async () => {
    const { projectId, headers } = await newProject("mcp-auth-collision");
    const name = uniqueEnvironmentName();
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .environments({ name })
        .put(
          { content: environmentContent({ connectors: ["playwright"] }) },
          { headers },
        ),
    );

    const { data, error } = await apiClient.api["step-definitions"].put(
      {
        ...stepPayload(projectId, {
          playwright: { type: "ref", auth: { connection: "notion" } },
        }),
        environment: { kind: "named", name },
      },
      { headers },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "STEP_ENVIRONMENT_CONNECTOR_COLLISION",
    });
  });
});
