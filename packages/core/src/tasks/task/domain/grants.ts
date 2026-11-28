import { z } from "zod";

/** Labels on a work item: at most 50, each trimmed, non-empty and at most 200 chars. */
export const labelsSchema = z.array(z.string().trim().min(1).max(200)).max(50);

/**
 * What a Task's agent may do, action by action. A grant names its resource,
 * an action on it and the scope it covers:
 *
 * - `self`: the Task's own work item.
 * - `children`: its children, existing or created earlier in the same run.
 * - `project`: any work item in the Task's project. Only `read`, `create` and
 *   `update` accept it, and `update` on `project` only on `code` steps.
 *
 * `create` on `children` makes children of the Task's work item; `create` on
 * `project` makes top-level items in the Task's project, keyed by an external
 * id so a repeat create returns the existing item. `update` on `project` lets
 * a code step write items the project already has, including closing and
 * reopening them. `create` and `label` name the labels they may set, add or
 * remove; `update` on `project` may name them too.
 *
 * `create` and `update` on `project` may carry a `keyPrefix`: the grant then
 * covers only items whose `platformKey` starts with it, so a step can hold
 * one grant per source. A step's work-item grants never go beyond what the
 * claiming user may do: every use also checks the user's project permission.
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
/** The scopes a `create` grant may cover. */
export type CreateGrantScope = "children" | "project";

const grantLabelsSchema = labelsSchema
  .min(1)
  .refine((labels) => new Set(labels).size === labels.length, {
    message: "Grant labels must be unique",
  });

/** A `platformKey` prefix a `project` grant is limited to. */
export const grantKeyPrefixSchema = z.string().min(1).max(200);

const resource = z.literal("workItem");
const scope = z.enum(changeScopeValues);
const keyPrefix = grantKeyPrefixSchema.optional();

export const grantSchema = z.discriminatedUnion("action", [
  z.object({
    resource,
    action: z.literal("read"),
    scope: z.enum(grantScopeValues),
  }),
  z.discriminatedUnion("scope", [
    z.object({ resource, action: z.literal("update"), scope }),
    z.object({
      resource,
      action: z.literal("update"),
      scope: z.literal("project"),
      keyPrefix,
      labels: grantLabelsSchema.optional(),
    }),
  ]),
  z.object({ resource, action: z.literal("comment"), scope }),
  z.object({
    resource,
    action: z.literal("label"),
    scope,
    labels: grantLabelsSchema,
  }),
  z.object({ resource, action: z.literal("block"), scope }),
  z.object({ resource, action: z.literal("close"), scope }),
  z.discriminatedUnion("scope", [
    z.object({
      resource,
      action: z.literal("create"),
      scope: z.literal("children"),
      labels: grantLabelsSchema,
    }),
    z.object({
      resource,
      action: z.literal("create"),
      scope: z.literal("project"),
      labels: grantLabelsSchema,
      keyPrefix,
    }),
  ]),
]);

export type Grant = z.infer<typeof grantSchema>;
/** A `create` grant on `project`. */
export type ProjectCreateGrant = Extract<
  Grant,
  { action: "create"; scope: "project" }
>;
/** An `update` grant on `project`. */
export type ProjectUpdateGrant = Extract<
  Grant,
  { action: "update"; scope: "project" }
>;

/** A grant's `(resource, action, scope, keyPrefix)`. */
export const grantKey = (grant: Grant) =>
  `${grant.resource}:${grant.action}:${grant.scope}:${"keyPrefix" in grant ? (grant.keyPrefix ?? "") : ""}`;

/** At most one grant per `(resource, action, scope, keyPrefix)`. */
export const grantsSchema = z
  .array(grantSchema)
  .refine((grants) => new Set(grants.map(grantKey)).size === grants.length, {
    message:
      "Grants must have at most one grant per resource, action, scope and key prefix",
  });

const unionLabels = (
  held: readonly string[] | undefined,
  added: readonly string[] | undefined,
): string[] | undefined =>
  held === undefined || added === undefined
    ? undefined
    : [...new Set([...held, ...added])];

/**
 * `held` with `added` joined in, at most one grant per `(resource, action,
 * scope, keyPrefix)`. When a grant for the same key is already held, their
 * labels are merged; an `update` grant naming no labels covers any, so it
 * stays unlimited. Never removes a grant.
 */
export const mergeGrants = (
  held: readonly Grant[],
  added: readonly Grant[],
): Grant[] => {
  const merged = new Map<string, Grant>(
    held.map((grant) => [grantKey(grant), { ...grant }]),
  );
  for (const grant of added) {
    const key = grantKey(grant);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...grant });
    } else if ("labels" in existing && existing.labels !== undefined) {
      const labels = unionLabels(
        existing.labels,
        "labels" in grant ? grant.labels : undefined,
      );
      const next: Grant & { labels?: string[] } = { ...existing };
      if (labels === undefined) {
        delete next.labels;
      } else {
        next.labels = labels;
      }
      merged.set(key, next);
    }
  }
  return [...merged.values()];
};

/**
 * The part of `requested` that `held` doesn't already cover. A grant with no
 * held grant of its key stays as asked. One whose key is held is dropped
 * when the held grant names no labels (it covers any) or names every label
 * asked for. A labelled grant only partly covered stays, narrowed to the
 * labels not held yet; an unlimited `update` asked over a labelled one stays.
 */
export const grantsNotHeld = (
  held: readonly Grant[],
  requested: readonly Grant[],
): Grant[] => {
  const heldByKey = new Map(held.map((grant) => [grantKey(grant), grant]));
  return requested.flatMap((grant): Grant[] => {
    const existing = heldByKey.get(grantKey(grant));
    if (existing === undefined) {
      return [{ ...grant }];
    }
    const heldLabels = "labels" in existing ? existing.labels : undefined;
    const asked = "labels" in grant ? grant.labels : undefined;
    if (heldLabels === undefined) {
      return [];
    }
    if (asked === undefined) {
      return [{ ...grant }];
    }
    const added = asked.filter((label) => !heldLabels.includes(label));
    return added.length === 0 ? [] : [{ ...grant, labels: added } as Grant];
  });
};

/**
 * Why `grants` don't fit a step of `kind`, one message per grant; empty when
 * they do. A `code` step may hold only `read`, `create` and `update` on
 * `project`; other steps may not hold `update` on `project`, which only code
 * steps use.
 */
export const grantKindRefusals = (
  kind: string,
  grants: readonly Grant[],
): string[] =>
  grants.flatMap((grant) => {
    if (kind === "code") {
      return grant.scope === "project"
        ? []
        : [
            `A 'code' step may only hold read, create and update grants on project, not ${grant.action} on ${grant.scope}`,
          ];
    }
    return grant.action === "update" && grant.scope === "project"
      ? [
          `Only a 'code' step may hold update on project; a '${kind}' step may not`,
        ]
      : [];
  });

const readSelf: Grant = { resource: "workItem", action: "read", scope: "self" };

/** The grants in `grants` scoped to the Task's own work item or its children. */
export const workItemScopedGrants = (grants: readonly Grant[]): Grant[] =>
  grants.filter((grant) => grant.scope !== "project");

/**
 * A Task's grants, from its step's grants and what it is about:
 *
 * - On a work item: the step's grants plus `read` on `self`, which every such
 *   Task has.
 * - Started by a schedule, with no work item: only the step's `project`
 *   grants, since there is no `self` or `children`.
 * - A chat: none.
 */
export const taskGrants = (
  stepGrants: readonly Grant[],
  subject: { workItemId: string | null; startedByScheduleId: string | null },
): Grant[] => {
  if (subject.workItemId === null) {
    if (subject.startedByScheduleId === null) {
      return [];
    }
    return stepGrants
      .filter((grant) => grant.scope === "project")
      .map((grant) => ({ ...grant }));
  }
  const grants = stepGrants.map((grant) => ({ ...grant }));
  if (findGrant(grants, "read", "self")) {
    return grants;
  }
  return [readSelf, ...grants];
};

/**
 * The `project` grant for `action` that covers `platformKey`: one with no
 * `keyPrefix`, or whose `keyPrefix` the key starts with. The longest matching
 * prefix wins, so labels come from the most specific grant.
 */
const projectGrantFor = <G extends ProjectCreateGrant | ProjectUpdateGrant>(
  grants: readonly Grant[],
  action: G["action"],
  platformKey: string,
): G | undefined => {
  const covering = grants.filter(
    (grant): grant is G =>
      grant.action === action &&
      grant.scope === "project" &&
      platformKey.startsWith((grant as G).keyPrefix ?? ""),
  );
  return covering.reduce<G | undefined>(
    (best, grant) =>
      best === undefined ||
      (grant.keyPrefix ?? "").length > (best.keyPrefix ?? "").length
        ? grant
        : best,
    undefined,
  );
};

/** The `create` grant on `project` that covers `platformKey`, if any. */
export const createGrantFor = (
  grants: readonly Grant[],
  platformKey: string,
): ProjectCreateGrant | undefined =>
  projectGrantFor<ProjectCreateGrant>(grants, "create", platformKey);

/** The `update` grant on `project` that covers `platformKey`, if any. */
export const updateGrantFor = (
  grants: readonly Grant[],
  platformKey: string,
): ProjectUpdateGrant | undefined =>
  projectGrantFor<ProjectUpdateGrant>(grants, "update", platformKey);

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
