import { oneLine } from "@scarn/core/tasks/task/application/task-summary-mapper";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type {
  nodeVisitKindValues,
  nodeVisitStatusValues,
} from "../../pipeline-run/contracts/pipeline-run-contracts";
import type { ProjectRunStatus } from "../contracts/project-runs-contracts";

/** What the status line needs to know about one visit. */
export type ProjectRunVisitFacts = {
  nodeId: string;
  nodeKind: (typeof nodeVisitKindValues)[number];
  status: (typeof nodeVisitStatusValues)[number];
  error: { name: string; message: string } | null;
  /** Step visits: whether the visit's latest Task is running (liveness applied). */
  taskRunning: boolean;
  /** The text of the visit's open question, if it asked one. */
  openQuestionBody: string | null;
};

/** What a pipeline run's status line and outcome are built from. */
export type PipelineRunLineFacts = {
  /** From `deriveProjectRunStatus`. */
  status: ProjectRunStatus;
  /** The run's visits, oldest first. */
  visits: readonly ProjectRunVisitFacts[];
  /** The run's pinned pipeline document; null if its version is gone. */
  document: PipelineDocument | null;
  endNodeId: string | null;
  /** The error the run stopped with, if any. */
  error: { name: string; message: string } | null;
};

const waitLine = (
  visit: ProjectRunVisitFacts,
  document: PipelineDocument | null,
  onViewer: boolean,
): string => {
  if (visit.openQuestionBody?.trim()) {
    return oneLine(visit.openQuestionBody);
  }
  const node = document?.nodes[visit.nodeId];
  const whose = onViewer ? "your" : "a";
  if (node?.kind === "wait" && node.for === "decision") {
    return `Waiting for ${whose} decision at ${visit.nodeId}`;
  }
  if (
    visit.nodeKind === "step" ||
    (node?.kind === "wait" && node.for === "reply")
  ) {
    return `Waiting for ${whose} reply at ${visit.nodeId}`;
  }
  return `Waiting at ${visit.nodeId}`;
};

const failEndError = (
  document: PipelineDocument | null,
  endNodeId: string | null,
): string | null => {
  const node = endNodeId ? document?.nodes[endNodeId] : undefined;
  return node?.kind === "fail" ? (node.error ?? null) : null;
};

const crashedVisit = (
  visits: readonly ProjectRunVisitFacts[],
): ProjectRunVisitFacts | undefined =>
  [...visits]
    .reverse()
    .find(
      (visit) =>
        visit.status === "failed" &&
        visit.nodeKind !== "fail" &&
        visit.error !== null,
    );

const runningLine = (visits: readonly ProjectRunVisitFacts[]): string => {
  const running = visits.filter(
    (visit) =>
      visit.nodeKind === "step" &&
      visit.status === "active" &&
      visit.taskRunning,
  );
  if (running.length > 1) {
    return `${String(running.length)} steps running: ${running.map((visit) => visit.nodeId).join(", ")}`;
  }
  return running[0] ? `Running ${running[0].nodeId}` : "Running";
};

const queuedLine = (visits: readonly ProjectRunVisitFacts[]): string => {
  const open = visits.find(
    (visit) => visit.nodeKind === "step" && visit.status === "active",
  );
  return open ? `Queued at ${open.nodeId}` : "Queued";
};

const doneLine = ({ visits, endNodeId }: PipelineRunLineFacts): string => {
  const end =
    endNodeId ??
    [...visits].reverse().find((visit) => visit.nodeKind === "succeed")?.nodeId;
  return end ? `Finished at ${end}` : "Finished";
};

/**
 * One line on where a pipeline run is, built from its visits and pinned
 * document so the list needs no per-row detail read: the open question or
 * the wait it is at, the running steps, the crashed step's error, the fail
 * end's error, or the end it finished at.
 */
export const pipelineRunStatusLine = (facts: PipelineRunLineFacts): string => {
  const { status, visits, document, endNodeId, error } = facts;
  switch (status) {
    case "needs-you":
    case "waiting": {
      const waiting = visits.find((visit) => visit.status === "waiting");
      return waiting
        ? waitLine(waiting, document, status === "needs-you")
        : "Waiting";
    }
    case "running":
      return runningLine(visits);
    case "queued":
      return queuedLine(visits);
    case "done":
      return doneLine(facts);
    case "ended": {
      const label = failEndError(document, endNodeId);
      return label
        ? oneLine(label)
        : endNodeId
          ? `Ended at ${endNodeId}`
          : "Ended";
    }
    case "failed": {
      const message = crashedVisit(visits)?.error?.message ?? error?.message;
      return message ? oneLine(message) : "Failed";
    }
    case "cancelled":
      return "Cancelled";
  }
};

/**
 * An `ended` run's fail-end error label (else the run's error name); a
 * `failed` run's raised error name (the run's, else its crashed step's);
 * otherwise null.
 */
export const pipelineRunOutcome = (
  facts: PipelineRunLineFacts,
): string | null => {
  switch (facts.status) {
    case "ended":
      return (
        failEndError(facts.document, facts.endNodeId) ??
        facts.error?.name ??
        null
      );
    case "failed":
      return (
        facts.error?.name ?? crashedVisit(facts.visits)?.error?.name ?? null
      );
    default:
      return null;
  }
};
