import { z } from "zod";
import { createClient } from "../../generated/client";
import { Environments } from "../../generated/sdk.gen";
import type {
  GetApiProjectsByProjectIdEnvironmentsByNameResponses,
  GetApiProjectsByProjectIdEnvironmentsResponses,
  PutApiProjectsByProjectIdEnvironmentsByNameData,
  PutApiProjectsByProjectIdEnvironmentsByNameResponses,
} from "../../generated/types.gen";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type EnvironmentSummary =
  GetApiProjectsByProjectIdEnvironmentsResponses[200][number];
export type EnvironmentDetail =
  GetApiProjectsByProjectIdEnvironmentsByNameResponses[200];
export type PublishEnvironmentContent =
  PutApiProjectsByProjectIdEnvironmentsByNameData["body"]["content"];
export type PublishEnvironmentResult =
  PutApiProjectsByProjectIdEnvironmentsByNameResponses[200];

const environmentContentIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** One validation error the server reports for rejected environment content. */
export type EnvironmentContentIssue = z.infer<
  typeof environmentContentIssueSchema
>;

type ApiError = {
  title?: string;
  detail?: string;
  code?: string;
  status?: number;
  errors?: unknown;
};

/**
 * Thrown when the API rejects a request. `issues` carries the per-path
 * validation errors of a `VALIDATION` rejection.
 */
export class EnvironmentsApiError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly issues: readonly EnvironmentContentIssue[];

  constructor(error: ApiError) {
    super(error.detail ?? error.title ?? JSON.stringify(error));
    this.name = "EnvironmentsApiError";
    this.code = error.code;
    this.status = error.status;
    this.issues = Array.isArray(error.errors)
      ? error.errors.flatMap((issue) => {
          const parsed = environmentContentIssueSchema.safeParse(issue);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) {
    throw new EnvironmentsApiError(result.error as ApiError);
  }
  return result.data as T;
}

export type EnvironmentsClient = ReturnType<typeof buildEnvironmentsClient>;

export function createEnvironmentsClient(baseUrl: string): EnvironmentsClient {
  const client = createClient({ baseUrl });
  return buildEnvironmentsClient(new Environments({ client }));
}

const buildEnvironmentsClient = (environments: Environments) => ({
  listByProjectId: async (
    projectId: string,
    options?: RequestOptions,
  ): Promise<EnvironmentSummary[]> =>
    unwrap(
      await environments.listEnvironments({
        path: { projectId },
        headers: options?.headers,
      }),
    ),
  /** The latest version's content, or version `options.version` when given. */
  get: async (
    projectId: string,
    name: string,
    options?: RequestOptions & { version?: number },
  ): Promise<EnvironmentDetail> =>
    unwrap(
      await environments.getEnvironment({
        path: { projectId, name },
        ...(options?.version === undefined
          ? {}
          : { query: { version: options.version } }),
        headers: options?.headers,
      }),
    ),
  /**
   * Publishes `content` as the environment's next version, creating the
   * environment when the name is new or deleted. `published` is false when it
   * matched the latest version.
   */
  publish: async (
    projectId: string,
    name: string,
    content: PublishEnvironmentContent,
    options?: RequestOptions,
  ): Promise<PublishEnvironmentResult> =>
    unwrap(
      await environments.publishEnvironmentVersion({
        path: { projectId, name },
        body: { content },
        headers: options?.headers,
      }),
    ),
  delete: async (
    projectId: string,
    name: string,
    options?: RequestOptions,
  ): Promise<void> => {
    unwrap(
      await environments.deleteEnvironment({
        path: { projectId, name },
        headers: options?.headers,
      }),
    );
  },
});
