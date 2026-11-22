import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { codeStep, defineMcp, defineStep } from "@scarn/sdk/definitions/steps";
import { healthChecksSchema } from "@scarn/sdk/health-checks";
import { z } from "zod";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createAppContext } from "@/lib/di";
import { createScarnApiClient } from "tests/treaty";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  createPipelineFromDocument,
  singleStepPipelineDocument,
} from "../../pipeline-test-support";
import {
  environmentContent,
  uniqueEnvironmentName,
} from "../../environment/integration/environment-test-support";

describe("named environment step definitions", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let projectId: UuidV7;
  let headers: { authorization: string };

  beforeAll(async () => {
    apiClient = createScarnApiClient(createApp(createAppContext()));
    const owner = await createTestUserAndSession({
      email: `named-environment-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Named environment project",
          description: null,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const environmentRoute = (name: string) =>
    apiClient.api.projects({ projectId }).environments({ name });

  const publishEnvironment = async (
    name: string,
    connectors?: string[],
  ): Promise<void> => {
    await unwrapAsync(
      environmentRoute(name).put(
        { content: environmentContent(connectors ? { connectors } : {}) },
        { headers },
      ),
    );
  };

  const putAgentStep = async (
    environment: string,
    opencodeMcpJson: Record<string, unknown> | null = null,
  ) =>
    await apiClient.api["step-definitions"].put(
      {
        projectId,
        key: `named-${crypto.randomUUID()}`,
        name: "Named agent",
        kind: "user_defined",
        version: 1,
        description: null,
        prompt: "Do the thing",
        inputSchemaJson: { type: "object", properties: {} },
        resultSchemaJson: null,
        status: "active",
        environment: { kind: "named", name: environment },
        opencodeMcpJson: opencodeMcpJson as never,
      },
      { headers },
    );

  concurrentTest(
    "an environment the project doesn't have is rejected",
    async () => {
      const name = uniqueEnvironmentName();

      const { data, error } = await putAgentStep(name);

      expect(data).toBeNull();
      expect(error?.status).toBe(400);
      expect(error?.value).toMatchObject({
        code: "STEP_ENVIRONMENT_NOT_FOUND",
      });
      expect(JSON.stringify(error?.value)).toContain(name);
    },
  );

  concurrentTest("a deleted environment is rejected", async () => {
    const name = uniqueEnvironmentName();
    await publishEnvironment(name);
    await unwrapAsync(environmentRoute(name).delete(undefined, { headers }));

    const { data, error } = await putAgentStep(name);

    expect(data).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "STEP_ENVIRONMENT_NOT_FOUND" });
  });

  concurrentTest(
    "a step MCP server that reuses one of the environment's connector ids is rejected",
    async () => {
      const name = uniqueEnvironmentName();
      await publishEnvironment(name, ["playwright"]);

      const { data, error } = await putAgentStep(name, {
        playwright: { type: "remote", url: "https://example.test/mcp" },
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(400);
      expect(error?.value).toMatchObject({
        code: "STEP_ENVIRONMENT_CONNECTOR_COLLISION",
      });
      expect(JSON.stringify(error?.value)).toContain(
        'step mcps \\"playwright\\" collide',
      );
    },
  );

  concurrentTest(
    "the collision check uses the environment's latest version",
    async () => {
      const name = uniqueEnvironmentName();
      await publishEnvironment(name, ["playwright"]);
      await publishEnvironment(name);

      const created = await unwrapAsync(
        putAgentStep(name, {
          playwright: { type: "remote", url: "https://example.test/mcp" },
        }),
      );

      expect(created.environment).toEqual({ kind: "named", name });
    },
  );

  for (const kind of ["user_defined", "code"] as const) {
    concurrentTest(
      `${kind} SDK compilation naming a published environment survives PUT, GET and pipeline publication`,
      async () => {
        const key = `named-${crypto.randomUUID()}`;
        const environment = uniqueEnvironmentName();
        const release = uniqueEnvironmentName();
        await publishEnvironment(environment);
        await publishEnvironment(release);
        const spec =
          kind === "code"
            ? codeStep({
                key,
                name: "Named code",
                environment,
                fn: () => ({}),
                inputSchema: z.object({}),
                resultSchema: z.object({}),
              })
            : defineStep({
                key,
                name: "Named agent",
                environment,
                input: z.object({}),
                result: z.object({}),
                agentPrompt: ({ env }) => `Use ${String(env["SERVICE_URL"])}`,
                mcps: {
                  db: defineMcp({
                    type: "ref",
                    name: "postgres",
                    env: ["DATABASE_URL"],
                    healthChecks: {
                      query: { tool: "query", args: { sql: "select 1" } },
                    },
                  }),
                },
              });
        const payload = {
          projectId,
          key,
          name: spec.name,
          kind,
          version: 1,
          description: spec.description,
          inputSchemaJson: spec.inputSchemaJson,
          resultSchemaJson: spec.resultSchemaJson,
          status: "active" as const,
          prompt: spec.prompt,
          environment: spec.environment,
          opencodeMcpJson: spec.opencodeMcpJson,
          healthChecksJson: spec.healthChecksJson,
          ...(kind === "code"
            ? {
                entrypointJson: {
                  sourceFile: ".scarn/pipeline-builder/named.ts",
                },
              }
            : {}),
        };
        const created = await unwrapAsync(
          apiClient.api["step-definitions"].put(payload, { headers }),
        );
        expect(created.environment).toEqual({
          kind: "named",
          name: environment,
        });
        expect(created.opencodeMcpJson).toEqual(spec.opencodeMcpJson);
        expect(created.healthChecksJson).toEqual(
          spec.healthChecksJson === null
            ? null
            : healthChecksSchema.parse(spec.healthChecksJson),
        );
        const updated = await unwrapAsync(
          apiClient.api["step-definitions"].put(
            {
              ...payload,
              environment: { kind: "named", name: release },
            },
            { headers },
          ),
        );
        expect(updated.id).toBe(created.id);
        const fetched = await unwrapAsync(
          apiClient.api["step-definitions"]({
            stepDefinitionId: parseUuidV7(created.id),
          }).get({ headers }),
        );
        expect(fetched.environment).toEqual({ kind: "named", name: release });
        expect(fetched.opencodeMcpJson).toEqual(spec.opencodeMcpJson);

        const pipeline = await createPipelineFromDocument(
          apiClient,
          headers,
          projectId,
          singleStepPipelineDocument(
            `named-pipeline-${crypto.randomUUID()}`,
            key,
          ),
        );
        const published = await unwrapAsync(
          apiClient.api["pipeline-definitions"]({
            pipelineDefinitionId: parseUuidV7(pipeline.id),
          })
            .versions({ version: 1 })
            .get({ headers }),
        );
        expect(published.steps).toEqual([
          {
            stepKey: key,
            stepDefinitionId: created.id,
          },
        ]);
        expect(published.definition).toMatchObject({
          nodes: { "only-step": { kind: "step", step: key } },
        });
      },
    );
  }
});
