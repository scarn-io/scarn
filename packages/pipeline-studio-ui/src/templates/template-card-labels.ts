/** The text on a template's gallery card, kept free of React so it's unit tested. */
import type { PipelineTemplateCard, TemplateParameter } from "./templates-api";

function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * "N step(s)" for the steps in the graph, plus "+M hand-off" for the steps an
 * agent starts. The server's `stepCount` includes hand-off steps.
 */
export function formatStepCount(
  card: Pick<PipelineTemplateCard, "stepCount" | "handoffStepCount">,
): string {
  const graphSteps = plural(card.stepCount - card.handoffStepCount, "step");
  return card.handoffStepCount > 0
    ? `${graphSteps} +${String(card.handoffStepCount)} hand-off`
    : graphSteps;
}

/** "No setup" with no required parameters, else "N required setting(s)". */
export function formatSetupLabel(
  parameters: readonly Pick<TemplateParameter, "required">[],
): string {
  const required = parameters.filter((param) => param.required).length;
  return required === 0 ? "No setup" : plural(required, "required setting");
}

/** "Optional: a, b" naming the optional parameters by label, or null when there are none. */
export function formatOptionalSettings(
  parameters: readonly Pick<TemplateParameter, "required" | "label">[],
): string | null {
  const optional = parameters.filter((param) => !param.required);
  return optional.length === 0
    ? null
    : `Optional: ${optional.map((param) => param.label).join(", ")}`;
}

export function hasStepConflicts(
  card: Pick<PipelineTemplateCard, "conflicts">,
): boolean {
  return card.conflicts.takenStepKeys.length > 0;
}
