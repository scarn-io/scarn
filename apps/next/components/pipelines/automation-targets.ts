import type { AutomationContract } from "@scarn/api/frontend-contracts";
import {
  automationDocumentSchema,
  type AutomationTargetJson,
} from "@scarn/sdk/contracts/automation-document";

/**
 * What an automation's latest version starts, in rule order without
 * repeats: each pipeline by name (its key if unknown) and each step by key.
 * Attach and skip targets start nothing; an unpublished or unreadable
 * document starts nothing either.
 */
export function automationStarts(
  automation: AutomationContract,
  pipelineNames: ReadonlyMap<string, string>,
): string[] {
  const parsed = automationDocumentSchema.safeParse(
    automation.latestVersion?.document,
  );
  if (!parsed.success) return [];
  const targets: AutomationTargetJson[] = parsed.data.rules.flatMap((rule) => [
    ...rule.next.routes,
    ...(rule.next.otherwise === undefined ? [] : [rule.next.otherwise]),
  ]);
  const names = targets.flatMap((target) => {
    if (target.kind === "pipeline") {
      return [pipelineNames.get(target.to) ?? target.to];
    }
    if (target.kind === "step") return [target.to];
    return [];
  });
  return [...new Set(names)];
}
