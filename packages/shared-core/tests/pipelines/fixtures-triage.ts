import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import issueTriage from "../../../sdks/js/test/pipelines/fixtures/issue-triage";
import { clone, type Doc } from "./fixtures";

/** The plan's `match: "all"` example, compiled by the SDK: routes side by side, a partial merge and a cascading closing merge. */
export function triagePipeline(): Doc {
  return clone(issueTriage.document);
}

export const triageSteps: StepCatalog = issueTriage.steps;
