import { indentJson } from "./format-tasks";
import type { GatheredTaskRunView } from "./gather-tasks";
import type { TaskRunArtifact, TaskRunDetail } from "./lib/task-api-types";
import { looseStatusGlyph } from "./lib/status-glyphs";

/** Text rendering for `task-runs view`. */

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function workerLines(run: TaskRunDetail): string[] {
  if (run.claimedBy === null) return ["Worker:       not claimed"];
  const lines = [
    `Worker:       ${run.claimedBy}${run.claimedAt === null ? "" : `  claimed ${run.claimedAt}`}`,
  ];
  if (run.lastHeartbeatAt !== null) {
    lines.push(`Heartbeat:    ${run.lastHeartbeatAt}`);
  }
  if (run.leaseExpiresAt !== null) {
    const every =
      run.heartbeatSeconds === null
        ? ""
        : `  (every ${String(run.heartbeatSeconds)}s)`;
    lines.push(`Lease until:  ${run.leaseExpiresAt}${every}`);
  }
  return lines;
}

function timingLines(run: TaskRunDetail): string[] {
  const lines = [`Created:      ${run.createdAt}`];
  if (run.startedAt !== null) lines.push(`Started:      ${run.startedAt}`);
  if (run.completedAt !== null) lines.push(`Completed:    ${run.completedAt}`);
  if (run.executionDeadlineAt !== null) {
    lines.push(`Deadline:     ${run.executionDeadlineAt}`);
  }
  return lines;
}

function branchLines(run: TaskRunDetail): string[] {
  const lines: string[] = [];
  if (run.baseBranch !== null || run.baseCommit !== null) {
    lines.push(
      `Base:         ${run.baseBranch ?? "(default branch)"}${run.baseCommit === null ? "" : ` @ ${run.baseCommit}`}`,
    );
  }
  if (run.workBranch !== null) {
    const from =
      run.createdFromBranch === null ? "" : `  from ${run.createdFromBranch}`;
    lines.push(`Work branch:  ${run.workBranch}${from}`);
  }
  if (run.sessionRestored !== null) {
    lines.push(
      `Session:      ${run.sessionRestored ? "restored from the previous run" : "not restored"}`,
    );
  }
  return lines;
}

function artifactLine(artifact: TaskRunArtifact): string {
  const type = artifact.contentType === null ? "" : `  ${artifact.contentType}`;
  return `  ${artifact.relativeStorePath}  ${artifact.kind}${type}  ${formatBytes(artifact.sizeBytes)}  ${artifact.id}`;
}

export function formatTaskRunView(gathered: GatheredTaskRunView): string {
  const { run, artifacts } = gathered;
  const lines = [
    `Task run ${run.id}  ${looseStatusGlyph(run.status)} ${run.status}`,
    `Task:         ${run.taskId}  run #${String(run.number)} (${run.reason})`,
    `Kind:         ${run.kind}${run.name === null ? "" : `  ${run.name}`}`,
  ];
  if (run.workItemId !== null) lines.push(`Work item:    ${run.workItemId}`);
  if (run.previousTaskRunId !== null) {
    lines.push(`Previous run: ${run.previousTaskRunId}`);
  }
  lines.push(...workerLines(run), ...timingLines(run), ...branchLines(run));
  if (run.resultJson !== null) {
    lines.push("", "Result:", ...indentJson(run.resultJson, "  "));
  }
  if (run.errorJson !== null) {
    lines.push("", "Error:", ...indentJson(run.errorJson, "  "));
  }

  lines.push("");
  if (artifacts.status === "unavailable") {
    lines.push(`Artifacts: unavailable (${artifacts.reason})`);
  } else if (artifacts.data.length === 0) {
    lines.push("Artifacts: none");
  } else {
    lines.push(`Artifacts (${String(artifacts.data.length)}):`);
    for (const artifact of artifacts.data) lines.push(artifactLine(artifact));
  }

  lines.push(
    "",
    `→ scarn logs ${run.id}`,
    `→ scarn artifacts list ${run.id}`,
    `→ scarn tasks view ${run.taskId}`,
  );
  return lines.join("\n");
}
