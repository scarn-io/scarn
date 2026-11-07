import type { WorkItemChange } from "@scarn/sdk/contracts/work-item-changes";
import type { Grant, GrantAction, GrantScope } from "./current-execution";

/**
 * The plugin's side of the grant checks: which scopes a tool may act on, the
 * labels it may set, and refusing a change the server would refuse, as far as
 * the plugin can tell. It knows the Task's own work item; any other id is
 * taken to be a child and its parentage is left to the server.
 */

type LabelGrant = Extract<Grant, { labels: string[] }>;

export function findGrant<A extends GrantAction>(
  grants: readonly Grant[],
  action: A,
  scope: GrantScope,
): Extract<Grant, { action: A }> | undefined {
  return grants.find(
    (grant): grant is Extract<Grant, { action: A }> =>
      grant.action === action && grant.scope === scope,
  );
}

/** The scopes `grants` hold `action` on, `self` first. */
export function grantScopes(
  grants: readonly Grant[],
  action: GrantAction,
): GrantScope[] {
  return (["self", "children", "project"] as const).filter(
    (scope) => findGrant(grants, action, scope) !== undefined,
  );
}

const SCOPE_PHRASES: Record<GrantScope, string> = {
  self: "your own work item",
  children: "your work item's children",
  project: "any work item in the project",
};

/** "your own work item", "your work item's children", or both. */
export function scopePhrase(scopes: readonly GrantScope[]): string {
  return scopes.map((scope) => SCOPE_PHRASES[scope]).join(" and ");
}

/** A tool description's sentence naming the scopes `action` may act on. */
export function scopeNote(
  grants: readonly Grant[],
  action: GrantAction,
): string {
  if (findGrant(grants, action, "project")) {
    return `Works on ${SCOPE_PHRASES.project}.`;
  }
  return `Works on ${scopePhrase(grantScopes(grants, action))} only.`;
}

/** Every label the `action` grants (`label` or `create`) allow, in order. */
export function grantedLabels(
  grants: readonly Grant[],
  action: LabelGrant["action"],
): string[] {
  return [
    ...new Set(
      grants.flatMap((grant) => (grant.action === action ? grant.labels : [])),
    ),
  ];
}

function scopeOf(ownWorkItemId: string, workItemId: string): GrantScope {
  return workItemId === ownWorkItemId ? "self" : "children";
}

function missingScopedGrant(
  action: GrantAction,
  workItemId: string,
  scope: GrantScope,
): string {
  return `This Task may not ${action} work item ${workItemId}: it has no \`${action}\` grant on \`${scope}\`.`;
}

function labelsOutside(
  grant: LabelGrant,
  labels: readonly string[],
  workItemId: string,
): string | null {
  const outside = labels.filter((label) => !grant.labels.includes(label));
  if (outside.length === 0) {
    return null;
  }
  return `This Task may not ${grant.action} work item ${workItemId} with labels ${outside.join(", ")}: its \`${grant.action}\` grant on \`${grant.scope}\` covers ${grant.labels.join(", ")}.`;
}

/** A refusal when `grants` hold no `action` on the scope of `workItemId`. */
export function checkGrantOn(
  grants: readonly Grant[],
  ownWorkItemId: string,
  action: GrantAction,
  workItemId: string,
): string | null {
  if (findGrant(grants, action, "project")) {
    return null;
  }
  const scope = scopeOf(ownWorkItemId, workItemId);
  return findGrant(grants, action, scope)
    ? null
    : missingScopedGrant(action, workItemId, scope);
}

/** What the plugin knows about the run when checking a change. */
export type GrantCheckContext = {
  grants: readonly Grant[];
  ownWorkItemId: string;
};

/**
 * A block needs a `block` grant on the blocked item's scope, and the blocking
 * item must be in that scope too.
 */
function checkBlock(
  { grants, ownWorkItemId }: GrantCheckContext,
  blockedWorkItemId: string,
  blockingWorkItemId: string,
): string | null {
  const refusal = checkGrantOn(
    grants,
    ownWorkItemId,
    "block",
    blockedWorkItemId,
  );
  if (refusal !== null) {
    return refusal;
  }
  const blockedScope = scopeOf(ownWorkItemId, blockedWorkItemId);
  if (scopeOf(ownWorkItemId, blockingWorkItemId) !== blockedScope) {
    return `This Task may not block work item ${blockedWorkItemId} on ${blockingWorkItemId}: its \`block\` grant on \`${blockedScope}\` doesn't cover ${blockingWorkItemId}.`;
  }
  return null;
}

/**
 * A refusal for a change the server would refuse for lack of a grant, or
 * null when the plugin can't tell it apart from an allowed one.
 */
export function checkChangeGrants(
  context: GrantCheckContext,
  change: WorkItemChange,
): string | null {
  const { grants, ownWorkItemId } = context;
  switch (change.kind) {
    case "block":
      return checkBlock(
        context,
        change.blockedWorkItemId,
        change.blockingWorkItemId,
      );
    case "describe":
      return checkGrantOn(grants, ownWorkItemId, "update", change.workItemId);
    case "comment":
    case "close":
      return checkGrantOn(
        grants,
        ownWorkItemId,
        change.kind,
        change.workItemId,
      );
    case "label": {
      const scope = scopeOf(ownWorkItemId, change.workItemId);
      const grant = findGrant(grants, "label", scope);
      if (!grant) {
        return missingScopedGrant("label", change.workItemId, scope);
      }
      return labelsOutside(
        grant,
        [...(change.add ?? []), ...(change.remove ?? [])],
        change.workItemId,
      );
    }
  }
}
