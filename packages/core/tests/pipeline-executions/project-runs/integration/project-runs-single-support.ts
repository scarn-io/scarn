/** Reads one row of the Runs list as a member, a guest or anyone else. */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  ProjectRunContract,
  ProjectRunLookupKind,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { unwrapAsync } from "tests/utils";
import { apiClient, type Viewer } from "./project-runs-test-support";

type RunLookup = { type: ProjectRunLookupKind; id: UuidV7 };

const getRun = (viewer: Viewer, projectId: UuidV7, lookup: RunLookup) =>
  apiClient.api
    .projects({ projectId })
    .runs({ type: lookup.type })({ id: lookup.id })
    .get({ headers: viewer ? { ...viewer.authHeaders } : {} });

/** One run as `viewer` sees it, through `GET /projects/:projectId/runs/:type/:id`. */
export const readRun = async (
  viewer: Viewer,
  projectId: UuidV7,
  lookup: RunLookup,
): Promise<ProjectRunContract> =>
  await unwrapAsync(getRun(viewer, projectId, lookup));

/** The status the single-run read responds with when it refuses `lookup`. */
export const readRunError = async (
  viewer: Viewer,
  projectId: UuidV7,
  lookup: RunLookup,
): Promise<{ status: number; code?: string }> => {
  const { error } = await getRun(viewer, projectId, lookup);
  if (!error) {
    throw new Error("Expected the run read to be refused");
  }
  return { ...(error.value as { code?: string }), status: error.status };
};
