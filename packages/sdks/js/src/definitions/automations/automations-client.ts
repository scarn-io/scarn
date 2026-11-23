import { z } from "zod";
import type { ScarnClientOptions } from "../../client";
import { createApiClient } from "../../create-api-client";
import { Automations } from "../../generated/sdk.gen";
import type {
  GetApiProjectsByProjectIdAutomationsResponses,
  PutApiProjectsByProjectIdAutomationsByKeyResponses,
} from "../../generated/types.gen";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type PublishAutomationResult =
  PutApiProjectsByProjectIdAutomationsByKeyResponses[200];
export type Automation = PublishAutomationResult["automation"];
/** A project's automation as the list shows it, with its live schedule rules. */
export type AutomationListItem =
  GetApiProjectsByProjectIdAutomationsResponses[200][number];
export type AutomationScheduleSummary = AutomationListItem["schedules"][number];

const automationDocumentIssueSchema = z.object({
  code: z.string(),
  path: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

/** One validation error the server reports for a rejected automation document. */
export type AutomationDocumentIssue = z.infer<
  typeof automationDocumentIssueSchema
>;

type ApiError = {
  title?: string;
  detail?: string;
  code?: string;
  meta?: { [key: string]: unknown };
};

/**
 * Thrown when the API rejects a request. `issues` carries the per-path
 * validation errors of an `AUTOMATION_DOCUMENT_INVALID` rejection; `heldBy`
 * the Tasks holding a full concurrency group (`Scarn.ConcurrencyGroupFull`).
 */
export class AutomationsApiError extends Error {
  readonly code: string | undefined;
  readonly issues: readonly AutomationDocumentIssue[];
  readonly heldBy: readonly string[];

  constructor(error: ApiError) {
    super(error.detail ?? error.title ?? JSON.stringify(error));
    this.name = "AutomationsApiError";
    this.code = error.code;
    const heldBy = error.meta?.["heldBy"];
    this.heldBy = Array.isArray(heldBy)
      ? heldBy.filter((id): id is string => typeof id === "string")
      : [];
    const errors = error.meta?.["errors"];
    this.issues = Array.isArray(errors)
      ? errors.flatMap((issue) => {
          const parsed = automationDocumentIssueSchema.safeParse(issue);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) {
    throw new AutomationsApiError(result.error as ApiError);
  }
  return result.data as T;
}

export function createAutomationsClient(
  baseUrl: string,
  options?: ScarnClientOptions,
): ReturnType<typeof buildAutomationsClient> {
  const client = createApiClient(baseUrl, { fetch: options?.fetch });
  return buildAutomationsClient(new Automations({ client }));
}

const buildAutomationsClient = (automations: Automations) => ({
  listByProjectId: async (projectId: string, options?: RequestOptions) =>
    unwrap(
      await automations.listAutomations({
        path: { projectId },
        headers: options?.headers,
      }),
    ),
  /**
   * Publishes `document` as the automation's next version, creating the
   * automation (disabled) when its key is new. `published` is false when it
   * matched the latest version.
   */
  publish: async (
    projectId: string,
    key: string,
    document: Record<string, unknown>,
    options?: RequestOptions,
  ) =>
    unwrap(
      await automations.publishAutomation({
        path: { projectId, key },
        body: { document },
        headers: options?.headers,
      }),
    ),
  enable: async (projectId: string, key: string, options?: RequestOptions) =>
    unwrap(
      await automations.enableAutomation({
        path: { projectId, key },
        headers: options?.headers,
      }),
    ),
  disable: async (projectId: string, key: string, options?: RequestOptions) =>
    unwrap(
      await automations.disableAutomation({
        path: { projectId, key },
        headers: options?.headers,
      }),
    ),
  /**
   * Run now: fires the schedule rule `ruleKey` once, for now. `taskId` is
   * null when the rule routed to `skip`. A full concurrency group throws
   * with code `Scarn.ConcurrencyGroupFull` and `heldBy` set.
   */
  runSchedule: async (
    projectId: string,
    key: string,
    ruleKey: string,
    options?: RequestOptions,
  ) =>
    unwrap(
      await automations.runAutomationSchedule({
        path: { projectId, key, ruleKey },
        headers: options?.headers,
      }),
    ),
  listForWorkItem: async (workItemId: string, options?: RequestOptions) =>
    unwrap(
      await automations.listWorkItemAutomations({
        path: { workItemId },
        headers: options?.headers,
      }),
    ),
  attach: async (workItemId: string, key: string, options?: RequestOptions) =>
    unwrap(
      await automations.attachWorkItemAutomation({
        path: { workItemId, key },
        headers: options?.headers,
      }),
    ),
  detach: async (workItemId: string, key: string, options?: RequestOptions) =>
    unwrap(
      await automations.detachWorkItemAutomation({
        path: { workItemId, key },
        headers: options?.headers,
      }),
    ),
});
