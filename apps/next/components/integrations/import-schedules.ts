import type {
  AutomationListItemContract,
  AutomationScheduleSummaryContract,
} from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/sdk/definitions/steps";
import { automationDocumentSchema } from "@scarn/sdk/contracts/automation-document";

/** The integration an import schedule writes work items for. */
export type ImportedIntegration =
  | { kind: "jira"; externalScope: { projectKeys: readonly string[] } }
  | {
      kind: "github_token";
      externalScope: { repos: ReadonlyArray<{ fullName: string }> };
    };

/** A project automation's schedule rule that imports an integration's issues. */
export type ImportSchedule = {
  automation: Pick<AutomationListItemContract, "key" | "title" | "enabled">;
  schedule: AutomationScheduleSummaryContract;
};

/**
 * The work-item key prefixes the library pollers grant for an integration:
 * `KEY-` per Jira project key, `owner/repo#` per GitHub repo.
 */
export function importKeyPrefixes(
  integration: ImportedIntegration,
): Set<string> {
  return new Set(
    integration.kind === "jira"
      ? integration.externalScope.projectKeys.map((key) => `${key}-`)
      : integration.externalScope.repos.map((repo) => `${repo.fullName}#`),
  );
}

const importsInto = (grants: readonly Grant[], prefixes: Set<string>) =>
  grants.some(
    (grant) =>
      (grant.action === "create" || grant.action === "update") &&
      grant.scope === "project" &&
      grant.keyPrefix !== undefined &&
      prefixes.has(grant.keyPrefix),
  );

/**
 * The project automations' schedule rules that start a step granted to
 * create or update project work items under one of the integration's key
 * prefixes, as the `jiraIssueImport` and `githubIssueImport` steps are.
 */
export function importSchedulesFor(
  integration: ImportedIntegration,
  automations: readonly AutomationListItemContract[],
  stepGrants: ReadonlyMap<string, readonly Grant[]>,
): ImportSchedule[] {
  const prefixes = importKeyPrefixes(integration);
  return automations.flatMap((automation) => {
    if (automation.scope !== "project") return [];
    const parsed = automationDocumentSchema.safeParse(
      automation.latestVersion?.document,
    );
    if (!parsed.success) return [];
    return parsed.data.rules.flatMap((rule) => {
      if (rule.event !== "schedule") return [];
      const targets = [
        ...rule.next.routes,
        ...(rule.next.otherwise === undefined ? [] : [rule.next.otherwise]),
      ];
      const imports = targets.some(
        (target) =>
          target.kind === "step" &&
          importsInto(stepGrants.get(target.to) ?? [], prefixes),
      );
      const schedule = automation.schedules.find(
        (summary) => summary.key === rule.key,
      );
      return imports && schedule ? [{ automation, schedule }] : [];
    });
  });
}
