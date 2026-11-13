import type { ApiResult, AuthHeaders } from "./api-result";
import type {
  PipelineDefinitionWithVersion,
  PipelineVersion,
  StepDefinitionSummary,
} from "./pipeline-api-types";

/**
 * The slice of the generated `ScarnClient` that `pipelines show` calls. A
 * real client matches it at runtime but not structurally (the generated
 * nullable fields are `unknown`; see `./api-result.ts`), so the CLI casts
 * once with `as unknown as PipelineReadClient`.
 */
export type PipelineReadClient = {
  pipelineDefinitions: {
    listPipelineDefinitions: (options: {
      path: { projectId: string };
      query: { includeArchived?: boolean };
      headers: AuthHeaders;
    }) => Promise<ApiResult<PipelineDefinitionWithVersion[]>>;
    getPipelineDefinitionVersion: (options: {
      path: { pipelineDefinitionId: string; version: number };
      headers: AuthHeaders;
    }) => Promise<ApiResult<PipelineVersion>>;
  };
  stepDefinitions: {
    getStepDefinition: (options: {
      path: { stepDefinitionId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<StepDefinitionSummary>>;
  };
};
