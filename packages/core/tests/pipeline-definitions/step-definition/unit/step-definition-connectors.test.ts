import { describe, expect, test } from "bun:test";
import { createStepDefinitionInputSchema } from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-contracts";
import { resolveTaskExecutionConfigInputSchema } from "@scarn/core/tasks/task-execution-config/contracts/task-execution-config-contracts";
import {
  environmentRefFromStored,
  storedEnvironmentFromRef,
} from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-runtime";

const projectId = "019a0000-0000-7000-8000-000000000000";

const stepInput = (
  environment: object,
  opencodeMcpJson: object | null = null,
) => ({
  projectId,
  key: "connectors",
  name: "Connectors",
  description: null,
  prompt: "Use the connectors.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: null,
  environment,
  opencodeMcpJson,
  status: "draft" as const,
});

const datadogEnv = {
  kind: "inline",
  envJson: [
    { name: "DD_API_KEY", source: "secret", secretName: "DD_API_KEY" },
    {
      name: "DD_APPLICATION_KEY",
      source: "secret",
      secretName: "DD_APPLICATION_KEY",
    },
  ],
  connectors: ["datadog"],
};

describe("inline environment connectors at publish", () => {
  test("accepts catalog connectors beside other step mcps", () => {
    const parsed = createStepDefinitionInputSchema.safeParse(
      stepInput(datadogEnv, { mine: { type: "local", command: ["mine"] } }),
    );
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown connector id", () => {
    const parsed = createStepDefinitionInputSchema.safeParse(
      stepInput({ kind: "inline", connectors: ["nope"] }),
    );
    expect(parsed.error?.issues[0]?.message).toContain(
      'unknown connector "nope"',
    );
  });

  test("rejects a step mcps key that reuses a connector id", () => {
    const input = stepInput(datadogEnv, {
      datadog: { type: "remote", url: "https://example.test/mcp" },
    });
    for (const schema of [
      createStepDefinitionInputSchema,
      resolveTaskExecutionConfigInputSchema,
    ]) {
      const parsed = schema.safeParse(input);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(["opencodeMcpJson"]);
      expect(parsed.error?.issues[0]?.message).toContain(
        'step mcps "datadog" collide with the environment\'s connectors',
      );
    }
  });

  test("the schema leaves a named environment to the upsert's repo check", () => {
    const parsed = createStepDefinitionInputSchema.safeParse(
      stepInput(
        { kind: "named", name: "obs" },
        { datadog: { type: "remote", url: "https://example.test/mcp" } },
      ),
    );
    expect(parsed.success).toBe(true);
  });

  test("connectors survive the stored round trip", () => {
    const ref = {
      kind: "inline" as const,
      connectors: ["playwright"],
    };
    expect(environmentRefFromStored(storedEnvironmentFromRef(ref))).toEqual(
      ref,
    );
  });
});
