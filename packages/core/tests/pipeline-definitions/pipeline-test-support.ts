import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";

type ApiClient = ReturnType<typeof createScarnTreaty>;
type AuthHeaders = { authorization: string };

export const SINGLE_STEP_NODE_ID = "only-step";

/** `steps` run in order, each by step-definition key, then the run succeeds. */
export const chainedPipelineDocument = (
  key: string,
  steps: ReadonlyArray<{ nodeId: string; stepKey: string }>,
): PipelineDocument => {
  const nodes: PipelineDocument["nodes"] = { done: { kind: "succeed" } };
  steps.forEach((step, index) => {
    nodes[step.nodeId] = {
      kind: "step",
      step: step.stepKey,
      next: {
        routes: [{ to: steps[index + 1]?.nodeId ?? "done" }],
      },
    };
  });
  const [first] = steps;
  if (!first) {
    throw new Error("A pipeline needs at least one step");
  }
  return {
    schemaVersion: 1,
    key,
    start: { to: first.nodeId },
    nodes,
  };
};

export const singleStepPipelineDocument = (
  key: string,
  stepKey: string,
): PipelineDocument =>
  chainedPipelineDocument(key, [{ nodeId: SINGLE_STEP_NODE_ID, stepKey }]);

export const buildAgentStepDefinitionPayload = (
  projectId: UuidV7,
  key: string = `step-${crypto.randomUUID()}`,
) => ({
  projectId,
  key,
  name: "Test step",
  description: "Step seeded for a test",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

/** Creates a pipeline whose version 1 is `document`. */
export const createPipelineFromDocument = async (
  apiClient: ApiClient,
  authHeaders: AuthHeaders,
  projectId: UuidV7,
  document: PipelineDocument,
  name = "Test pipeline",
) =>
  await unwrapAsync(
    apiClient.api["pipeline-definitions"].post(
      {
        projectId,
        key: document.key,
        name,
        document,
      },
      { headers: { ...authHeaders } },
    ),
  );

/**
 * Creates an agent step definition (unless `stepDefinitionKey` names an
 * existing one) and a single-step pipeline over it.
 */
export const createSingleStepPipeline = async (
  apiClient: ApiClient,
  authHeaders: AuthHeaders,
  projectId: UuidV7,
  stepDefinitionKey?: string,
) => {
  let stepKey = stepDefinitionKey;
  if (!stepKey) {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildAgentStepDefinitionPayload(projectId),
        { headers: { ...authHeaders } },
      ),
    );
    stepKey = stepDefinition.key;
  }
  const definition = await createPipelineFromDocument(
    apiClient,
    authHeaders,
    projectId,
    singleStepPipelineDocument(`pipeline-${crypto.randomUUID()}`, stepKey),
  );
  return { ...definition, id: parseUuidV7(definition.id), stepKey };
};

/** The newest Task queued for `nodeId` in a run, from the run contract. */
export const latestTaskIdForNode = (
  execution: {
    visits: ReadonlyArray<{
      nodeId: string;
      status: string;
      tasks: ReadonlyArray<{ taskId: UuidV7 }>;
    }>;
  },
  nodeId: string = SINGLE_STEP_NODE_ID,
): UuidV7 => {
  const visit = execution.visits
    .filter((item) => item.nodeId === nodeId && item.status !== "superseded")
    .at(-1);
  const taskId = visit?.tasks.at(-1)?.taskId;
  if (!taskId) {
    throw new Error(`Expected a queued Task for node ${nodeId}`);
  }
  return taskId;
};
