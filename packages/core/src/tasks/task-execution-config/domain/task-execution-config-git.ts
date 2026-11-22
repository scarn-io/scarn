import { resolveRepoConfig } from "@scarn/core/common/contracts/repo-config";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { TaskExecutionConfigGitInput } from "../contracts/task-execution-config-contracts";
import type { StoredGitConfig } from "../contracts/task-execution-config-stored";

/**
 * Applies the runtime default to `input` once, then enforces the git
 * invariants (D9): `message` is only carried
 * by `readWrite`, and `onPushFailure` is set exactly for `readWrite`.
 */
export const resolveTaskExecutionConfigGit = (
  input: TaskExecutionConfigGitInput | null | undefined,
): StoredGitConfig => {
  const git = resolveRepoConfig(input);

  if (input && input.mode !== "readWrite") {
    if ("message" in input && input.message != null) {
      throw new CoreValidationError(
        `repo message requires mode 'readWrite', got '${input.mode}'`,
        "TASK_EXECUTION_CONFIG_GIT_MESSAGE_NOT_ALLOWED",
      );
    }
    if ("onPushFailure" in input && input.onPushFailure != null) {
      throw new CoreValidationError(
        `repo onPushFailure requires mode 'readWrite', got '${input.mode}'`,
        "TASK_EXECUTION_CONFIG_GIT_ON_PUSH_FAILURE_NOT_ALLOWED",
      );
    }
  }

  return git;
};
