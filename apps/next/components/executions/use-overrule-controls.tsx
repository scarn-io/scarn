"use client";

import { useState } from "react";
import type {
  NodeVisitContract,
  PipelineExecutionContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import { canOverruleVisit } from "./execution-step-action-guards";
import { OverruleRouteDialog } from "./overrule-route-dialog";
import type { OverruleContextValue } from "./overrule-route-section";
import { failedRunOverrule, nodeNext } from "./overrule-routes";
import type { PostVisitRoute } from "./use-overrule-route";

/**
 * The run page's overrule wiring: who may overrule which visit, the
 * Overrule dialog (open on at most one visit), and the failed-run banner's
 * offer. Overruling is gated like a rerun (`canRerun`).
 */
export function useOverruleControls({
  execution,
  version,
  viewerUserId,
  canWrite,
  postVisitRoute,
  onApplied,
}: {
  execution: PipelineExecutionContract | null;
  version: PipelineVersionContract | null;
  viewerUserId: string | null;
  canWrite: boolean;
  postVisitRoute: PostVisitRoute;
  onApplied: () => void;
}) {
  const [visitId, setVisitId] = useState<string | null>(null);
  const canOverrule = (visit: NodeVisitContract) =>
    canWrite &&
    execution !== null &&
    canOverruleVisit(execution, visit, nodeNext(version, visit.nodeId));
  const context: OverruleContextValue = {
    version,
    viewerUserId,
    canOverrule,
    openOverrule: (visit) => {
      setVisitId(visit.id);
    },
  };
  const dialogVisit =
    execution?.visits.find((visit) => visit.id === visitId) ?? null;
  const dialog = dialogVisit ? (
    <OverruleRouteDialog
      key={dialogVisit.id}
      visit={dialogVisit}
      version={version}
      postVisitRoute={postVisitRoute}
      onClose={() => {
        setVisitId(null);
      }}
      onApplied={() => {
        setVisitId(null);
        onApplied();
      }}
    />
  ) : null;
  const failed = execution ? failedRunOverrule(execution, version) : null;
  const failedOverrule =
    failed && canOverrule(failed.visit)
      ? {
          endTitle: failed.endTitle,
          onOverrule: () => {
            setVisitId(failed.visit.id);
          },
        }
      : null;
  return { context, dialog, failedOverrule };
}
