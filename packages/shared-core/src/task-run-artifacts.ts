import { describeApiError } from "./lib/api-errors";
import type { AuthHeaders } from "./lib/api-result";
import type { ArtifactDownloadUrl } from "./lib/api-types";
import type {
  TaskRunArtifact,
  TaskRunArtifactFailure,
} from "./lib/task-api-types";
import type { TaskRunDebugClient } from "./lib/task-run-debug-client";
import { formatBytes } from "./format-task-run";

/**
 * The reads and text rendering behind `scarn artifacts list` and `scarn
 * artifacts download`.
 */

export type GatheredArtifacts = {
  taskRunId: string;
  artifacts: TaskRunArtifact[];
  /** Uploads that failed; only loaded with `--failures`. */
  failures?: TaskRunArtifactFailure[];
};

export async function gatherArtifacts(options: {
  client: TaskRunDebugClient;
  headers: AuthHeaders;
  taskRunId: string;
  failures: boolean;
}): Promise<GatheredArtifacts> {
  const { client, headers, taskRunId } = options;
  const [artifacts, failures] = await Promise.all([
    client.taskRuns.listTaskArtifacts({ path: { taskRunId }, headers }),
    options.failures
      ? client.taskRuns.listTaskArtifactFailures({
          path: { taskRunId },
          headers,
        })
      : undefined,
  ]);
  if (artifacts.error?.status === 404) {
    throw new Error(`Task run ${taskRunId} not found.`);
  }
  if (artifacts.error !== undefined) {
    throw new Error(
      `Could not list the artifacts of Task run ${taskRunId}: ${describeApiError(artifacts.error)}`,
    );
  }
  if (failures?.error !== undefined) {
    throw new Error(
      `Could not list the artifact failures of Task run ${taskRunId}: ${describeApiError(failures.error)}`,
    );
  }
  return failures === undefined
    ? { taskRunId, artifacts: artifacts.data }
    : { taskRunId, artifacts: artifacts.data, failures: failures.data };
}

function artifactLine(artifact: TaskRunArtifact): string {
  const type = artifact.contentType === null ? "" : `  ${artifact.contentType}`;
  return `  ${artifact.id}  ${artifact.relativeStorePath}  ${artifact.kind}${type}  ${formatBytes(artifact.sizeBytes)}  ${artifact.createdAt}`;
}

function failureLines(failure: TaskRunArtifactFailure): string[] {
  const status =
    failure.httpStatus === null ? "" : ` (HTTP ${String(failure.httpStatus)})`;
  return [
    `  ✗ ${failure.relativeStorePath}  ${failure.kind}  ${formatBytes(failure.attemptedSizeBytes)}  ${failure.createdAt}`,
    `    ${failure.errorCode}${status}: ${failure.errorMessage}`,
  ];
}

export function formatArtifactList(gathered: GatheredArtifacts): string {
  const { taskRunId, artifacts, failures } = gathered;
  const lines =
    artifacts.length === 0
      ? [`No artifacts recorded by Task run ${taskRunId}.`]
      : [
          `Artifacts of Task run ${taskRunId} (${String(artifacts.length)}):`,
          ...artifacts.map(artifactLine),
        ];
  if (failures !== undefined) {
    lines.push(
      "",
      failures.length === 0
        ? "Failed uploads: none"
        : `Failed uploads (${String(failures.length)}):`,
      ...failures.flatMap(failureLines),
    );
  }
  lines.push("");
  const first = artifacts[0];
  lines.push(
    first === undefined
      ? `→ scarn logs ${taskRunId}`
      : `→ scarn artifacts download ${taskRunId} ${first.id}`,
    `→ scarn task-runs view ${taskRunId}`,
  );
  return lines.join("\n");
}

/**
 * Picks the artifact `ref` names: by id first, then by its store path, then
 * by the path's last segment (when that is unambiguous).
 */
export function findArtifact(
  artifacts: readonly TaskRunArtifact[],
  ref: string,
): TaskRunArtifact {
  const byId = artifacts.find((artifact) => artifact.id === ref);
  if (byId !== undefined) return byId;
  const byPath = artifacts.find(
    (artifact) => artifact.relativeStorePath === ref,
  );
  if (byPath !== undefined) return byPath;
  const byName = artifacts.filter(
    (artifact) => artifact.relativeStorePath.split("/").at(-1) === ref,
  );
  const [only] = byName;
  if (byName.length === 1 && only !== undefined) return only;
  if (byName.length > 1) {
    throw new Error(
      `${String(byName.length)} artifacts are named ${ref}; pass an id or the full path:\n${byName.map(artifactLine).join("\n")}`,
    );
  }
  throw new Error(
    `No artifact ${ref}. Known artifacts:\n${artifacts.length === 0 ? "  (none)" : artifacts.map(artifactLine).join("\n")}`,
  );
}

/** Resolves `ref` to an artifact and its presigned download URL. */
export async function resolveArtifactDownload(options: {
  client: TaskRunDebugClient;
  headers: AuthHeaders;
  taskRunId: string;
  ref: string;
}): Promise<{
  artifact: TaskRunArtifact;
  url: string;
  download: ArtifactDownloadUrl;
}> {
  const { client, headers, taskRunId, ref } = options;
  const { artifacts } = await gatherArtifacts({
    client,
    headers,
    taskRunId,
    failures: false,
  });
  const artifact = findArtifact(artifacts, ref);
  const result = await client.taskRuns.getArtifactDownloadUrl({
    path: { taskRunId, artifactId: artifact.id },
    headers,
  });
  if (result.error !== undefined) {
    throw new Error(
      `Could not get a download URL for artifact ${artifact.id}: ${describeApiError(result.error)}`,
    );
  }
  if (result.data.url === null) {
    throw new Error(
      `Artifact ${artifact.id} has no download URL (the object store cannot presign one).`,
    );
  }
  return { artifact, url: result.data.url, download: result.data };
}
