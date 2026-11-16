import { WorkerAuthError } from "../../../auth/session/domain/worker-auth-error";
import { ProjectUnavailableError } from "../contracts/project-unavailable-error";
import type {
  TaskRunWorkerClaim,
  TaskRunWorkerClient,
} from "../contracts/process-project-work-types";
import {
  ProjectSecretsRequestError,
  type RequestProjectSecrets,
} from "./resolve-secret-env";

/**
 * Asks Scarn for a claimed run's project secrets
 * (`POST /task-runs/:id/environment`). A failed call (network, stale claim)
 * becomes a {@link ProjectSecretsRequestError} naming the secrets, never their
 * values; auth and project-access errors pass through so the worker stops as
 * it does for any other route.
 */
export async function requestProjectSecrets(
  client: Pick<TaskRunWorkerClient, "resolveTaskRunEnvironment">,
  claim: Pick<TaskRunWorkerClaim, "claimToken"> & {
    task: Pick<TaskRunWorkerClaim["task"], "id">;
  },
  secretNames: readonly string[],
): ReturnType<RequestProjectSecrets> {
  try {
    if (!client.resolveTaskRunEnvironment) {
      throw new Error("this worker's client cannot reach Scarn");
    }
    return await client.resolveTaskRunEnvironment({
      taskRunId: claim.task.id,
      claimToken: claim.claimToken,
      secretNames: [...secretNames],
    });
  } catch (error) {
    if (
      error instanceof WorkerAuthError ||
      error instanceof ProjectUnavailableError
    ) {
      throw error;
    }
    throw new ProjectSecretsRequestError(secretNames, { cause: error });
  }
}
