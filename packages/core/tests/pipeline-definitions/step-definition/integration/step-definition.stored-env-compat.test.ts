/**
 * Reads legacy variable payloads nested in current `environment_json` rows,
 * bypassing the entity and the write schema, to prove already-stored data
 * stays readable through the real step definition GET and list endpoints
 * after the schema evolves. The step definition serves `environment.envJson`
 * from the task execution config it references. Historical physical columns
 * no longer exist; versioned-row reader coverage lives in the config repo tests.
 *
 * `V1_ENV_JSON` is a frozen copy of what v1 wrote. Never edit it to make this
 * test pass; the shared stored-vars reader must preserve its defaults.
 */
import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { EnvVarSpec } from "@scarn/core/common/contracts/env-vars";
import {
  anyJsonValueSchema,
  type AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import { eq } from "drizzle-orm";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { stepDefinitions, taskExecutionConfigs } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const V1_ENV_JSON = anyJsonValueSchema.parse(
  JSON.parse(
    '[{"name":"ACCOUNT_ID","source":"value","value":"{{input.accountId}}","secret":false},' +
      '{"name":"DB_PASSWORD","source":"inherit","from":"STAGING_DB_PASSWORD","secret":true,"optional":false},' +
      '{"name":"LOG_LEVEL","source":"inherit","from":"LOG_LEVEL","secret":false,"optional":true,"default":"info"}]',
  ),
);

const V1_EXPECTED: EnvVarSpec[] = [
  {
    name: "ACCOUNT_ID",
    source: "value",
    value: "{{input.accountId}}",
    secret: false,
    applies: "agent",
  },
  {
    name: "DB_PASSWORD",
    source: "inherit",
    from: "STAGING_DB_PASSWORD",
    secret: true,
    optional: false,
    applies: "agent",
  },
  {
    name: "LOG_LEVEL",
    source: "inherit",
    from: "LOG_LEVEL",
    secret: false,
    optional: true,
    default: "info",
    applies: "agent",
  },
];

describe("step definition stored environment vars compatibility", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  const writeStoredEnvJson = async (id: UuidV7, vars: AnyJsonValue) => {
    const [row] = await getDb()
      .select({ taskExecutionConfigId: stepDefinitions.taskExecutionConfigId })
      .from(stepDefinitions)
      .where(eq(stepDefinitions.id, id));
    if (!row?.taskExecutionConfigId) {
      throw new Error(
        `Expected step definition ${id} to reference a task execution config`,
      );
    }
    await getDb()
      .update(taskExecutionConfigs)
      .set({ schemaVersion: 3, environmentJson: { kind: "inline", vars } })
      .where(eq(taskExecutionConfigs.id, row.taskExecutionConfigId));
  };

  beforeAll(async () => {
    const app = createApp(createAppContext());
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-env-compat-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Env Compat Project",
          description: "Project for stored env_json compatibility tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(project.id),
          key: `env_compat_${crypto.randomUUID()}`,
          name: "Env compat",
          description: "Stored env_json compatibility step",
          prompt: "Return a result payload.",
          version: 1,
          kind: "user_defined" as const,
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          environment: {
            kind: "inline",
            envJson: [
              {
                name: "PLACEHOLDER",
                source: "value" as const,
                value: "x",
                secret: false,
                applies: "agent" as const,
              },
            ],
          },
          status: "draft" as const,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = created.id;
  });

  serialTest(
    "serves raw v1 vars nested in a current row through get and list",
    async () => {
      if (!stepDefinitionId || !authHeaders || !project) {
        throw new Error("Expected the step definition to be created first");
      }

      await writeStoredEnvJson(stepDefinitionId, V1_ENV_JSON);

      const fetched = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId }).get({
          headers: { ...authHeaders },
        }),
      );
      const listed = await unwrapAsync(
        apiClient.api["step-definitions"].get({
          query: { projectId: parseUuidV7(project.id) },
          headers: { ...authHeaders },
        }),
      );

      expect(fetched.environment).toEqual({
        kind: "inline",
        envJson: V1_EXPECTED,
      });
      expect(
        listed.find((item) => item.id === stepDefinitionId)?.environment,
      ).toEqual({ kind: "inline", envJson: V1_EXPECTED });
    },
  );

  serialTest(
    "round-trips a project secret var through put and get",
    async () => {
      if (!stepDefinitionId || !authHeaders || !project) {
        throw new Error("Expected the step definition to be created first");
      }
      const secretVar = {
        name: "GITHUB_TOKEN",
        source: "secret" as const,
        secretName: "GH_BOT_TOKEN",
        applies: "agent" as const,
      };

      await writeStoredEnvJson(stepDefinitionId, [
        { name: "GITHUB_TOKEN", source: "secret", secretName: "GH_BOT_TOKEN" },
      ]);
      const fetched = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId }).get({
          headers: { ...authHeaders },
        }),
      );
      expect(fetched.environment).toEqual({
        kind: "inline",
        envJson: [secretVar],
      });

      const key = `env_secret_${crypto.randomUUID()}`;
      const created = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            projectId: parseUuidV7(project.id),
            key,
            name: "Env secret",
            description: "Project secret var step",
            prompt: "Return a result payload.",
            version: 1,
            kind: "user_defined" as const,
            inputSchemaJson: { type: "object" },
            resultSchemaJson: { type: "object" },
            environment: { kind: "inline", envJson: [secretVar] },
            status: "draft" as const,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const refetched = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get(
          { headers: { ...authHeaders } },
        ),
      );
      expect(refetched.environment).toEqual({
        kind: "inline",
        envJson: [secretVar],
      });
    },
  );

  serialTest(
    "serves a row carrying an unknown future key and a now-reserved name",
    async () => {
      if (!stepDefinitionId || !authHeaders) {
        throw new Error("Expected the step definition to be created first");
      }

      await writeStoredEnvJson(stepDefinitionId, [
        {
          name: "HOME",
          source: "value",
          value: "x",
          secret: false,
          addedByNewerWriter: true,
        },
      ]);

      const fetched = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId }).get({
          headers: { ...authHeaders },
        }),
      );

      expect(fetched.environment).toEqual({
        kind: "inline",
        envJson: [
          {
            name: "HOME",
            source: "value",
            value: "x",
            secret: false,
            applies: "agent",
          },
        ],
      });
    },
  );
});
