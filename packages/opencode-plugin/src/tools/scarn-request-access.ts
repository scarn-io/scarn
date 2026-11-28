import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  buildGrantRequestPath,
  grantRequestSchema,
  grantSchema,
  type GrantRequest,
} from "@scarn/sdk/contracts/grant-request";
import { grantSentence } from "@scarn/sdk/definitions/steps/work-item-features";
import {
  loadCurrentExecutionInfo,
  type Grant,
  type GrantAction,
  type GrantScope,
} from "./_shared/current-execution";
import { invalidInputMessage } from "./_shared/work-item-tool-support";
import { resolveWorktree } from "./_shared/resolve-worktree";

export const SCARN_REQUEST_ACCESS_TOOL = "scarn-request-access";

export const REQUEST_RECORDED_MESSAGE =
  "Request recorded. End your turn now with one short message saying what you need and why. The Task waits until a person answers.";

export const NO_TURNS_LEFT_MESSAGE =
  "No turns are left in this step, so nobody can answer a request. Finish with the tools you have.";

/** The grants a Task's agent may ask for: every action and scope but `update` on `project`. */
const REQUESTABLE: readonly { action: GrantAction; scope: GrantScope }[] = [
  { action: "read", scope: "self" },
  { action: "read", scope: "children" },
  { action: "read", scope: "project" },
  ...(["update", "comment", "label", "block", "close"] as const).flatMap(
    (action) =>
      (["self", "children"] as const).map((scope) => ({ action, scope })),
  ),
  { action: "create", scope: "children" },
  { action: "create", scope: "project" },
];

const NEEDS_LABELS: ReadonlySet<GrantAction> = new Set(["label", "create"]);

function requestableLine({
  action,
  scope,
}: {
  action: GrantAction;
  scope: GrantScope;
}): string {
  const sentence = grantSentence({
    resource: "workItem",
    action,
    scope,
  } as Grant);
  const note = NEEDS_LABELS.has(action) ? " Name the `labels`." : "";
  return `- \`${action}\` on \`${scope}\`: ${sentence}${note}`;
}

/** The tool's description: what it does, what may be asked for, and what is held. */
export function requestAccessDescription(grants: readonly Grant[]): string {
  return [
    "Ask a person for more work item access when your tools don't allow something you need. Give the grants you need and why; then end your turn. The Task waits until a person answers, and the next turn has the tools that were approved. A second call before you end your turn replaces the first.",
    "",
    "You may ask for:",
    ...REQUESTABLE.map(requestableLine),
    "",
    "`create` on `project` may also take a `keyPrefix`.",
    "",
    "You already hold:",
    ...(grants.length === 0
      ? ["- Nothing."]
      : grants.map((grant) => `- ${grantSentence(grant)}`)),
  ].join("\n");
}

type RequestAccessInput = { reason?: unknown; grants?: unknown };

type GrantInput = {
  action?: unknown;
  scope?: unknown;
  labels?: unknown;
  keyPrefix?: unknown;
};

/** Whether `held` already covers all of `grant`, so the server would drop it. */
function isHeld(held: readonly Grant[], grant: Grant): boolean {
  const existing = held.find(
    (candidate) =>
      candidate.action === grant.action &&
      candidate.scope === grant.scope &&
      ("keyPrefix" in candidate ? candidate.keyPrefix : undefined) ===
        ("keyPrefix" in grant ? grant.keyPrefix : undefined),
  );
  if (existing === undefined) {
    return false;
  }
  const heldLabels = "labels" in existing ? existing.labels : undefined;
  if (heldLabels === undefined) {
    return true;
  }
  const asked = "labels" in grant ? grant.labels : undefined;
  return (
    asked !== undefined && asked.every((label) => heldLabels.includes(label))
  );
}

function parseRequestedGrant(entry: GrantInput, index: number): Grant | string {
  const parsed = grantSchema.safeParse({ ...entry, resource: "workItem" });
  if (!parsed.success) {
    return invalidInputMessage(
      `\`grants[${String(index)}]\` is not a grant you may ask for: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const grant = parsed.data;
  if (grant.action === "update" && grant.scope === "project") {
    return invalidInputMessage(
      "`update` on `project` is for code steps only; an agent may not ask for it.",
    );
  }
  return grant;
}

/**
 * Validates the request, refuses grants the Task already holds and requests
 * with no turns left, then writes `.scarn/grant-request.json` in the shape
 * the yield's `grantRequest` takes.
 */
export async function requestAccess(
  directory: string,
  input: RequestAccessInput,
): Promise<string> {
  const worktree = await resolveWorktree(directory);
  const info = await loadCurrentExecutionInfo(worktree);
  if (info.turnsRemaining === 0) {
    return NO_TURNS_LEFT_MESSAGE;
  }
  if (!Array.isArray(input.grants) || input.grants.length === 0) {
    return invalidInputMessage("`grants` must name at least one grant.");
  }
  const grants: Grant[] = [];
  for (const [index, entry] of (
    input.grants as (GrantInput | null)[]
  ).entries()) {
    const grant = parseRequestedGrant(entry ?? {}, index);
    if (typeof grant === "string") {
      return grant;
    }
    if (isHeld(info.grants, grant)) {
      return `You already hold this: ${grantSentence(grant)} Ask only for what you don't have.`;
    }
    grants.push(grant);
  }
  const request = grantRequestSchema.safeParse({
    reason: input.reason,
    grants,
  });
  if (!request.success) {
    return invalidInputMessage(
      typeof input.reason === "string" && input.reason.trim().length > 0
        ? request.error.issues.map((issue) => issue.message).join("; ")
        : "`reason` must say why you need these grants.",
    );
  }
  const body: GrantRequest = request.data;
  const filePath = buildGrantRequestPath(worktree);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return REQUEST_RECORDED_MESSAGE;
}

/** The `scarn-request-access` tool, bound to the plugin's directory. */
export function createScarnRequestAccessTool(
  directory: string,
  grants: readonly Grant[],
): ToolInfo {
  return {
    name: SCARN_REQUEST_ACCESS_TOOL,
    description: requestAccessDescription(grants),
    input: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you need these grants, in a sentence or two.",
        },
        grants: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "read",
                  "update",
                  "comment",
                  "label",
                  "block",
                  "close",
                  "create",
                ],
              },
              scope: { type: "string", enum: ["self", "children", "project"] },
              labels: { type: "array", items: { type: "string" } },
              keyPrefix: { type: "string" },
            },
            required: ["action", "scope"],
          },
        },
      },
      required: ["reason", "grants"],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: await requestAccess(directory, input as RequestAccessInput),
    }),
  };
}
