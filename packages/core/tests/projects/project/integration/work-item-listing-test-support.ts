import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { WorkItemContract } from "@/work-items/work-item/contracts/work-item-contracts";
import type { createScarnTreaty } from "tests/treaty";
import { unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import {
  buildAgentStepDefinitionPayload,
  createPipelineFromDocument,
  latestTaskIdForNode,
  singleStepPipelineDocument,
} from "tests/pipeline-definitions/pipeline-test-support";

/**
 * Shared seeding for the `GET /projects/:projectId/work-items` and
 * `.../work-item-field-options` suites. Everything here goes through the public
 * API client, which is what integration tests are allowed to touch.
 */

export type ListingApiClient = ReturnType<typeof createScarnTreaty>;
export type ListingAuthHeaders = { authorization: string };

export type ListingProject = {
  authHeaders: ListingAuthHeaders;
  projectId: UuidV7;
};

/** A fresh owner + project, so concurrent suites never share a result set. */
export const createListingProject = async (
  apiClient: ListingApiClient,
  label: string,
): Promise<ListingProject> => {
  const owner = await createTestUserAndSession({
    email: `${label}-${crypto.randomUUID()}@example.com`,
  });
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: `Work Item Listing ${label}`,
        description: `Project for the ${label} work item listing suite`,
        gitUrl: "https://github.com/example/test-project.git",
      },
      { headers: { ...owner.authHeaders } },
    ),
  );

  return {
    authHeaders: owner.authHeaders,
    projectId: parseUuidV7(project.id),
  };
};

export type WorkItemPlatform =
  "jira" | "github" | "linear" | "scarn" | "custom";

export type SeedWorkItemInput = {
  title?: string;
  description?: string;
  platform?: WorkItemPlatform;
  platformId?: string | null;
  platformKey?: string;
  url?: string | null;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  fields?: AnyJsonObject | null;
  labels?: string[];
};

/**
 * Bulk-create work items in one request. `POST /work-items/batch` returns the
 * created contracts in input order, and ids are UUID v7 so they ascend with
 * insertion — which the tiebreaker tests rely on.
 */
export const seedWorkItems = async (
  apiClient: ListingApiClient,
  { authHeaders, projectId }: ListingProject,
  inputs: SeedWorkItemInput[],
): Promise<WorkItemContract[]> =>
  await unwrapAsync(
    apiClient.api["work-items"].batch.post(
      inputs.map((input, index) => ({
        projectId,
        platform: input.platform ?? "github",
        platformId: input.platformId ?? `pid-${crypto.randomUUID()}`,
        platformKey: input.platformKey ?? `pk-${crypto.randomUUID()}`,
        url: input.url ?? null,
        title: input.title ?? `Seeded work item ${String(index)}`,
        description: input.description ?? `Seeded description ${String(index)}`,
        sourceCreatedAt: input.sourceCreatedAt ?? null,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        fields: input.fields === undefined ? {} : input.fields,
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      })),
      { headers: { ...authHeaders } },
    ),
  );

/** Step key the scoring pipeline runs; use in a `score:` sort token. */
export const SCORE_STEP_KEY = "score-step";
/** Numeric result path; use in a `score:` sort token for real score sorting. */
export const NUMERIC_SIGNAL_KEY = "score";
/** String result path, for pinning that a non-numeric value becomes `null`. */
export const TEXT_SIGNAL_KEY = "scoreText";

/**
 * A single-step pipeline running the `SCORE_STEP_KEY` step. Returned id is the
 * pipeline id segment of a `score:` sort token.
 */
export const createScoringPipeline = async (
  apiClient: ListingApiClient,
  { authHeaders, projectId }: ListingProject,
): Promise<UuidV7> => {
  await unwrapAsync(
    apiClient.api["step-definitions"].post(
      buildAgentStepDefinitionPayload(projectId, SCORE_STEP_KEY),
      { headers: { ...authHeaders } },
    ),
  );
  const definition = await createPipelineFromDocument(
    apiClient,
    authHeaders,
    projectId,
    singleStepPipelineDocument(
      `work_item_listing_pipeline_${crypto.randomUUID()}`,
      SCORE_STEP_KEY,
    ),
    "Work item listing score pipeline",
  );
  return parseUuidV7(definition.id);
};

/**
 * Run one execution of the scoring pipeline against a work item, then claim
 * and complete its lone Task with `status` and `resultJson`, which ends the
 * run.
 */
const runScoringExecution = async (
  apiClient: ListingApiClient,
  { authHeaders, projectId }: ListingProject,
  pipelineDefinitionId: UuidV7,
  workItemId: string,
  status: "succeeded" | "failed",
  resultJson: AnyJsonObject,
): Promise<void> => {
  const created = await unwrapAsync(
    apiClient.api["pipeline-executions"].post(
      {
        projectId,
        workItemId: parseUuidV7(workItemId),
        pipelineDefinitionId,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const taskId = latestTaskIdForNode(created);

  const claims = await unwrapAsync(
    apiClient.api["task-runs"].claims.post(
      {
        projectId,
        workItemId,
        workerId: `listing-worker-${crypto.randomUUID()}`,
        batchSize: 1,
        leaseDurationSeconds: 30,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claim = claims.find((item) => item.task.id === taskId);
  if (!claim) {
    throw new Error("Expected to claim the scoring pipeline's Task");
  }

  await unwrapAsync(
    apiClient.api["task-runs"]({ taskRunId: taskId }).completions.post(
      {
        claimToken: claim.claimToken,
        status,
        resultJson,
        errorJson: status === "failed" ? { message: "boom" } : null,
      },
      { headers: { ...authHeaders } },
    ),
  );
};

/** Drives one scoring execution to `status`; for the latest-execution-status suite. */
export const recordExecutionResult = async (
  apiClient: ListingApiClient,
  project: ListingProject,
  pipelineDefinitionId: UuidV7,
  workItemId: string,
  status: "succeeded" | "failed",
): Promise<void> => {
  await runScoringExecution(
    apiClient,
    project,
    pipelineDefinitionId,
    workItemId,
    status,
    {},
  );
};

export type SignalScorePayload = { score?: number; scoreText?: string };

/**
 * Run one succeeded execution of the scoring pipeline whose result is
 * `payload`, so the listing query's latest-score subquery has a row to join to.
 */
export const recordSignalScore = async (
  apiClient: ListingApiClient,
  project: ListingProject,
  pipelineDefinitionId: UuidV7,
  workItemId: string,
  payload: SignalScorePayload,
): Promise<void> => {
  await runScoringExecution(
    apiClient,
    project,
    pipelineDefinitionId,
    workItemId,
    "succeeded",
    payload,
  );
};
