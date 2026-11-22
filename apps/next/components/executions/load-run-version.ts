import type { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  parseUuidV7,
  pipelineVersionSchema,
  pipelineVersionSummarySchema,
} from "@scarn/api/frontend-contracts";
import type {
  PipelineDefinitionContract,
  PipelineExecutionContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";

type ApiClient = ReturnType<typeof getBrowserScarnApiClient>;

/**
 * Resolves the version a run is pinned to. The definition's current version
 * covers the common case; an older pin is found through the version list
 * (which is keyed by id) and then fetched by number.
 */
export async function loadRunVersion(
  apiClient: ApiClient,
  execution: Pick<
    PipelineExecutionContract,
    "pipelineDefinitionId" | "pipelineDefinitionVersionId"
  >,
  definition: PipelineDefinitionContract | null,
): Promise<PipelineVersionContract | null> {
  if (
    definition?.currentVersion?.id === execution.pipelineDefinitionVersionId
  ) {
    return definition.currentVersion;
  }
  const definitionRoute = apiClient.api["pipeline-definitions"]({
    pipelineDefinitionId: parseUuidV7(execution.pipelineDefinitionId),
  });
  const summaries = pipelineVersionSummarySchema
    .array()
    .parse(await unwrapTreatyResponse(definitionRoute.versions.get()));
  const pinned = summaries.find(
    (summary) => summary.id === execution.pipelineDefinitionVersionId,
  );
  if (!pinned) return null;
  return pipelineVersionSchema.parse(
    await unwrapTreatyResponse(
      definitionRoute.versions({ version: pinned.version }).get(),
    ),
  );
}
