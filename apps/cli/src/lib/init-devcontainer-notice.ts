import type { BaseReporter } from "./reporter-types";

/**
 * The devcontainer step of `scarn init`.
 *
 * Devcontainer configuration is optional. Repositories without one use the
 * managed `bun1` runtime by default, so its absence is a notice, not a gate.
 *
 * The check sits behind {@link DevcontainerNoticePorts} so both branches are
 * unit-testable without a repository on disk.
 */

export interface DevcontainerNoticePorts {
  /** Does this repository already carry a devcontainer config? */
  hasDevcontainer(): Promise<boolean>;
}

/** Spinner copy while the check runs. */
export const DEVCONTAINER_TASK_LABEL = "Checking devcontainer…";

/** Resolved task copy when one already exists. */
export const DEVCONTAINER_PRESENT_LABEL = "Devcontainer ready";

/**
 * Resolved task copy when none exists. Deliberately a statement of fact rather
 * than a failure: `init` completed this step successfully by determining that
 * there is nothing here yet.
 */
export const DEVCONTAINER_MISSING_LABEL = "No devcontainer yet";

/**
 * Explain the default runtime and the optional repository configuration.
 */
export const DEVCONTAINER_NOTICE_MESSAGE =
  "This repository has no devcontainer configuration. Scarn uses the managed " +
  "`bun1` runtime by default. No action is required: optionally add " +
  "`.devcontainer/devcontainer.json` to use a project-specific devcontainer.";

/**
 * Report whether the repository has a devcontainer, as a notice rather than a
 * gate. Returns the answer so callers can branch; only a failed *check* throws.
 */
export async function reportDevcontainerStatus(input: {
  reporter: BaseReporter;
  ports: DevcontainerNoticePorts;
}): Promise<{ present: boolean }> {
  const { reporter, ports } = input;

  const task = reporter.startActivity(DEVCONTAINER_TASK_LABEL);
  let present: boolean;
  try {
    present = await ports.hasDevcontainer();
  } catch (error) {
    // A missing devcontainer is a notice; a filesystem that cannot answer the
    // question is a real failure and must not be reported as "none found".
    task.fail("Devcontainer check failed");
    throw error;
  }

  if (present) {
    task.succeed(DEVCONTAINER_PRESENT_LABEL);
    return { present: true };
  }

  task.succeed(DEVCONTAINER_MISSING_LABEL);
  reporter.warn(DEVCONTAINER_NOTICE_MESSAGE);
  return { present: false };
}
