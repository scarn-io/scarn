import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import {
  createPipelineFromDocument,
  latestTaskIdForNode,
  singleStepPipelineDocument,
} from "tests/pipeline-definitions/pipeline-test-support";

export const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Claimable step",
  description: "Reusable step for execution claim tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: {
    type: "object",
  },
  resultSchemaJson: {
    type: "object",
  },
  opencodeMcpJson: {
    playwright: {
      type: "local" as const,
      command: ["npx", "-y", "@playwright/mcp@0.0.68"],
      disabled: false,
    },
  },
  environment: {
    kind: "inline" as const,
    runtime: {
      kind: "devcontainer" as const,
      config: ".devcontainer/alt/devcontainer.json",
    },
    envJson: [
      {
        name: "ACCOUNT_ID",
        source: "value" as const,
        value: "{{input.accountId}}",
        secret: false,
        applies: "agent" as const,
      },
    ],
  },
  repo: {
    mode: "readWrite" as const,
    message: "fix: {{result.summary}}",
    onPushFailure: "warn" as const,
  },
  status: "active" as const,
});

export const createTestWorkItem = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  key: string,
) =>
  await unwrapAsync(
    apiClient.api["work-items"].post(
      {
        projectId,
        platform: "github",
        platformId: `${key}-${crypto.randomUUID()}`,
        platformKey: `#${key}-${crypto.randomUUID()}`,
        url: `https://github.com/example/repo/issues/${key}`,
        title: `Work item for ${key}`,
        description: "Work item seeded for a task claims test",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: {},
      },
      { headers: { ...authHeaders } },
    ),
  );

/**
 * A single-step pipeline over the step definition keyed `stepKey`. Each
 * `inputJson` field becomes a literal start arg, so it lands in the queued
 * Task's input.
 */
export const createSingleStepPipelineDefinition = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepKey: string,
  inputJson: Record<string, AnyJsonValue> = {},
) => {
  const document = singleStepPipelineDocument(
    `claim-pipeline-${crypto.randomUUID()}`,
    stepKey,
  );
  const args = Object.fromEntries(
    Object.entries(inputJson).map(([key, value]) => [key, { value }]),
  );
  const definition = await createPipelineFromDocument(
    apiClient,
    authHeaders,
    projectId,
    Object.keys(args).length > 0
      ? { ...document, start: { ...document.start, args } }
      : document,
    "Claim pipeline",
  );
  return { ...definition, id: parseUuidV7(definition.id) };
};

/**
 * Queues a Task linked to a node visit by starting a single-step pipeline over
 * the step definition keyed `stepKey` on a fresh work item.
 */
export const createPipelineLinkedTask = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepKey: string,
  inputJson: Record<string, AnyJsonValue> = {},
) => {
  const workItem = await createTestWorkItem(
    apiClient,
    authHeaders,
    projectId,
    "pipeline-linked",
  );
  const definition = await createSingleStepPipelineDefinition(
    apiClient,
    authHeaders,
    projectId,
    stepKey,
    inputJson,
  );
  const execution = await unwrapAsync(
    apiClient.api["pipeline-executions"].post(
      {
        projectId,
        workItemId: parseUuidV7(workItem.id),
        pipelineDefinitionId: definition.id,
      },
      { headers: { ...authHeaders } },
    ),
  );
  return {
    id: latestTaskIdForNode(execution),
    workItemId: workItem.id,
    pipelineExecutionId: execution.id,
  };
};
