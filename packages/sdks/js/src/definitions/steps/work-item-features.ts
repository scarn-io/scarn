/**
 * `Features.workItems.*`: one work item grant per feature, with the prompt
 * section an agent step appends for it. Re-exported through `Features`.
 */
import type {
  ChangeGrantScope,
  CreateGrantScope,
  Grant,
  GrantAction,
  GrantScope,
  WorkItemFeature,
} from "./step-features";

const WORK_ITEM_TOOLS: Record<GrantAction, string> = {
  read: "scarn-get-work-item",
  update: "scarn-set-work-item-description",
  comment: "scarn-comment-on-work-item",
  label: "scarn-label-work-item",
  block: "scarn-block-work-item",
  close: "scarn-close-work-item",
  create: "scarn-create-work-item",
};

const WORK_ITEM_ACTION_TEXT: Record<GrantAction, string> = {
  read: "read",
  update: "replace the description of",
  comment: "comment on",
  label: "add or remove labels on",
  block: "mark as blocked",
  close: "close",
  create: "create",
};

const SCOPE_TEXT: Record<GrantScope, string> = {
  self: "your work item",
  children: "its child work items",
  project: "any work item in this project (pass its `workItemId`)",
};

const PROJECT_UPDATE_TEXT =
  "write work items this project already has, through `context.workItems.upsert`, including closing and reopening them";

const CREATE_SCOPE_TEXT: Record<CreateGrantScope, string> = {
  children: "child work items of your work item",
  project:
    "top-level work items in this project. Give each one a `platformKey`: a stable id from the system it comes from, such as the external item's id. Creating with a `platformKey` that already exists returns the existing item with `created: false` and changes nothing, so send every item you find without checking for duplicates first",
};

const scopeText = (action: GrantAction, scope: GrantScope): string =>
  action === "create" && scope !== "self"
    ? CREATE_SCOPE_TEXT[scope]
    : SCOPE_TEXT[scope];

const createHeading: Record<CreateGrantScope, string> = {
  children: "Create Child Work Items",
  project: "Create Work Items in the Project",
};

const scopeHeading: Record<GrantScope, string> = {
  self: "Your Work Item",
  children: "Child Work Items",
  project: "Any Work Item in the Project",
};

const actionHeading: Record<GrantAction, string> = {
  read: "Read",
  update: "Update",
  comment: "Comment on",
  label: "Label",
  block: "Block",
  close: "Close",
  create: "Create",
};

function workItemPrompt(grant: Grant): string {
  const heading =
    grant.action === "create"
      ? `## Work Items: ${createHeading[grant.scope]}`
      : `## Work Items: ${actionHeading[grant.action]} ${scopeHeading[grant.scope]}`;
  const lines = [
    heading,
    "",
    grant.action === "update" && grant.scope === "project"
      ? `You may ${PROJECT_UPDATE_TEXT}.`
      : `You may ${WORK_ITEM_ACTION_TEXT[grant.action]} ${scopeText(grant.action, grant.scope)}. Use the \`${WORK_ITEM_TOOLS[grant.action]}\` tool.`,
  ];
  if ("keyPrefix" in grant && grant.keyPrefix !== undefined) {
    lines.push(
      "",
      `Only items whose \`platformKey\` starts with \`${grant.keyPrefix}\`.`,
    );
  }
  if ("labels" in grant && grant.labels !== undefined) {
    lines.push(
      "",
      "Allowed labels:",
      ...grant.labels.map((label) => `- \`${label}\``),
      "",
      "Any other label is rejected.",
    );
  }
  return lines.join("\n");
}

function workItemFeature<TGrant extends Grant>(
  grant: TGrant,
): WorkItemFeature<TGrant> {
  return { _grant: grant, _promptAddition: workItemPrompt(grant) };
}

type CreateGrant<
  TScope extends CreateGrantScope,
  TLabels extends readonly string[],
> = Extract<Grant, { action: "create"; scope: TScope }> & {
  scope: TScope;
  labels: [...TLabels];
};

/** `update` on `project`: a code step writes items the project already has. */
export type ProjectUpdateGrant = Extract<
  Grant,
  { action: "update"; scope: "project" }
>;

type ScopeOptions = { scope: ChangeGrantScope };

type UpdateOptions =
  | { scope: ChangeGrantScope; keyPrefix?: never; labels?: never }
  | {
      scope: "project";
      /** Limits the grant to items whose `platformKey` starts with this. */
      keyPrefix?: string;
      /** The labels a write may set; any when omitted. */
      labels?: readonly [string, ...string[]];
    };

type UpdateGrantFor<TOptions extends UpdateOptions> = TOptions extends {
  scope: "project";
}
  ? ProjectUpdateGrant
  : {
      readonly resource: "workItem";
      readonly action: "update";
      readonly scope: TOptions["scope"];
    };

function updateFeature<const TOptions extends UpdateOptions>(
  options: TOptions,
): WorkItemFeature<UpdateGrantFor<TOptions>> {
  if (options.scope !== "project") {
    return workItemFeature({
      resource: "workItem",
      action: "update",
      scope: options.scope,
    } as UpdateGrantFor<TOptions>);
  }
  const { keyPrefix, labels } = options;
  return workItemFeature({
    resource: "workItem",
    action: "update",
    scope: "project",
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    ...(labels !== undefined ? { labels: [...labels] } : {}),
  } as UpdateGrantFor<TOptions>);
}

type LabelsOptions<TLabels extends readonly string[]> = {
  scope: ChangeGrantScope;
  labels: TLabels;
};

/**
 * Work item grants. Each builder gives the step's Tasks one action on their
 * work item (`scope: "self"`) or its children (`scope: "children"`), and adds
 * a prompt section naming the tool to use. `read` may also cover every work
 * item in the project (`scope: "project"`), and `create` may make top-level
 * items in it (`scope: "project"`). A code step may hold `read`, `create` and
 * `update` on `project` only, and uses them through `context.workItems`. A
 * step may attach at most one per action, scope and `keyPrefix`.
 */
export const workItems = {
  read: <const TScope extends GrantScope>({ scope }: { scope: TScope }) =>
    workItemFeature({ resource: "workItem", action: "read", scope } as const),
  /**
   * Replace the description of the Task's work item (`scope: "self"`) or its
   * children (`scope: "children"`). On `project`, a code step's
   * `context.workItems.upsert` may write items the project already has,
   * including closing and reopening them, limited to keys under `keyPrefix`
   * and to `labels` when given. `project` is for code steps only.
   */
  update: updateFeature,
  comment: ({ scope }: ScopeOptions) =>
    workItemFeature({
      resource: "workItem",
      action: "comment",
      scope,
    } as const),
  block: ({ scope }: ScopeOptions) =>
    workItemFeature({ resource: "workItem", action: "block", scope } as const),
  close: ({ scope }: ScopeOptions) =>
    workItemFeature({ resource: "workItem", action: "close", scope } as const),
  /** Add or remove the given labels; the agent may not touch any other. */
  label: <const TLabels extends readonly [string, ...string[]]>({
    scope,
    labels,
  }: LabelsOptions<TLabels>): WorkItemFeature<
    Extract<Grant, { action: "label" }> & { labels: [...TLabels] }
  > =>
    workItemFeature({
      resource: "workItem",
      action: "label",
      scope,
      labels: [...labels] as [...TLabels],
    }),
  /**
   * Create work items, each with labels from `labels` only: children of the
   * Task's work item (`scope: "children"`), or top-level items in the project
   * (`scope: "project"`), each keyed by a stable external id so a repeat
   * create returns the existing item. A scheduled step uses `project`.
   * `keyPrefix` (on `project` only) limits it to keys starting with it.
   */
  create: <
    const TScope extends CreateGrantScope,
    const TLabels extends readonly [string, ...string[]],
  >({
    scope,
    labels,
    keyPrefix,
  }: {
    scope: TScope;
    labels: TLabels;
  } & (TScope extends "project"
    ? { keyPrefix?: string }
    : { keyPrefix?: never })): WorkItemFeature<CreateGrant<TScope, TLabels>> =>
    workItemFeature({
      resource: "workItem",
      action: "create",
      scope,
      labels: [...labels],
      ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    } as CreateGrant<TScope, TLabels>),
} as const;
