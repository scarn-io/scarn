import type { StepPagePatch, StepView } from "./execution-detail-params";
import type { ExecutionStepItem } from "./execution-step-items";
import type { VisitDisplayStatus } from "./visit-status";

/**
 * The selected step as the run page's header shows it: the step bar under
 * the run's title, with the step page's view toggle, and rerunning the
 * selected visit for the `⋯` menu.
 */
export type ExecutionHeaderStep = {
  name: string;
  status: VisitDisplayStatus | null;
  view: StepView;
  onViewChange: (view: StepView) => void;
  /** Reruns the selected visit; `null` when it can't be rerun. */
  onRerun: (() => void) | null;
};

/** The header's step bar for the selected step and its URL-backed view. */
export function buildHeaderStep({
  step,
  status,
  view,
  onNavigate,
  onFullScreenChange,
  onRerun,
}: {
  step: ExecutionStepItem;
  status: VisitDisplayStatus | null;
  view: StepView;
  onNavigate: (patch: StepPagePatch) => void;
  onFullScreenChange: (fullScreen: boolean) => void;
  onRerun: (() => void) | null;
}): ExecutionHeaderStep {
  return {
    name: step.title,
    status,
    view,
    onViewChange: (next) => {
      if (next === view) return;
      if (next === "conversation") onFullScreenChange(false);
      onNavigate({ view: next });
    },
    onRerun,
  };
}
