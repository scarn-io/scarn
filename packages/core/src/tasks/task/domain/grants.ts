import { z } from "zod";

/** Labels on a work item: at most 50, each trimmed, non-empty and at most 200 chars. */
export const labelsSchema = z.array(z.string().trim().min(1).max(200)).max(50);

/**
 * What a Task's agent may do, action by action. A grant names its resource,
 * an action on it and the scope it covers:
 *
 * - `self`: the Task's own work item.
 * - `children`: its children, existing or created earlier in the same run.
 * - `project`: any work item in the Task's project. Only `read` accepts it.
 *
 * `create` only accepts `children`. `create` and `label` name the labels they
 * may set, add or remove.
 *
 * `read` includes the item's posted comments under the same scope, with no
 * additional permission. It excludes pending drafts, conversations, execution
 * transcripts and attachment downloads. Reading does not allow posting comments;
 * that requires `comment`. Related-item summaries do not include comments: read
 * the related item explicitly with a grant covering it.
 */
export const grantResourceValues = ["workItem"] as const;
export const grantActionValues = [
  "read",
  "update",
  "comment",
  "label",
  "block",
  "close",
  "create",
] as const;
export const grantScopeValues = ["self", "children", "project"] as const;
const changeScopeValues = ["self", "children"] as const;

export type GrantResource = (typeof grantResourceValues)[number];
export type GrantAction = (typeof grantActionValues)[number];
export type GrantScope = (typeof grantScopeValues)[number];
/** The scopes a grant that changes work items may cover. */
export type ChangeGrantScope = (typeof changeScopeValues)[number];

const grantLabelsSchema = labelsSchema
  .min(1)
  .refine((labels) => new Set(labels).size === labels.length, {
    message: "Grant labels must be unique",
  });

const resource = z.literal("workItem");
const scope = z.enum(changeScopeValues);

export const grantSchema = z.discriminatedUnion("action", [
  z.object({
    resource,
    action: z.literal("read"),
    scope: z.enum(grantScopeValues),
  }),
  z.object({ resource, action: z.literal("update"), scope }),
  z.object({ resource, action: z.literal("comment"), scope }),
  z.object({
    resource,
    action: z.literal("label"),
    scope,
    labels: grantLabelsSchema,
  }),
  z.object({ resource, action: z.literal("block"), scope }),
  z.object({ resource, action: z.literal("close"), scope }),
  z.object({
    resource,
    action: z.literal("create"),
    scope: z.literal("children"),
    labels: grantLabelsSchema,
  }),
]);

export type Grant = z.infer<typeof grantSchema>;

const grantKey = (grant: Grant) =>
  `${grant.resource}:${grant.action}:${grant.scope}`;

/** At most one grant per `(resource, action, scope)`. */
export const grantsSchema = z
  .array(grantSchema)
  .refine((grants) => new Set(grants.map(grantKey)).size === grants.length, {
    message:
      "Grants must have at most one grant per resource, action and scope",
  });

const readSelf: Grant = { resource: "workItem", action: "read", scope: "self" };

/**
 * A Task's grants: its step's grants plus `read` on `self`, which every Task
 * on a work item has. A Task without a work item (a chat) has no grants:
 * every grant is scoped to the Task's own work item.
 */
export const taskGrants = (
  stepGrants: readonly Grant[],
  workItemId: string | null,
): Grant[] => {
  if (workItemId === null) {
    return [];
  }
  const grants = stepGrants.map((grant) => ({ ...grant }));
  if (findGrant(grants, "read", "self")) {
    return grants;
  }
  return [readSelf, ...grants];
};

/** The work item grant for `action` on `scope`, if any. */
export const findGrant = <A extends GrantAction>(
  grants: readonly Grant[],
  action: A,
  scope: GrantScope,
): Extract<Grant, { action: A }> | undefined =>
  grants.find(
    (grant): grant is Extract<Grant, { action: A }> =>
      grant.action === action && grant.scope === scope,
  );

/**
 * Why a grant doesn't cover `labels` on `workItemId`, written for the agent;
 * null when every label is in the grant's labels.
 */
export const grantLabelsRefusal = (
  grant: Extract<Grant, { labels: string[] }>,
  labels: readonly string[],
  workItemId: string,
): string | null => {
  const outside = labels.filter((label) => !grant.labels.includes(label));
  if (outside.length === 0) {
    return null;
  }
  return `This Task may not ${grant.action} work item ${workItemId} with labels ${outside.join(", ")}: its ${grant.action} grant on ${grant.scope} covers ${grant.labels.join(", ")}`;
};

/** Every scope a work item grant for `action` covers. */
export const scopesFor = (
  grants: readonly Grant[],
  action: GrantAction,
): GrantScope[] =>
  grantScopeValues.filter(
    (scope) => findGrant(grants, action, scope) !== undefined,
  );
