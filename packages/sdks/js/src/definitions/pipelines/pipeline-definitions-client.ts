import { z } from "zod";
import { createClient } from "../../generated/client";
import { PipelineDefinitions } from "../../generated/sdk.gen";
import type {
  PostApiPipelineDefinitionsByPipelineDefinitionIdVersionsResponses,
  PostApiPipelineDefinitionsResponses,
} from "../../generated/types.gen";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type PipelineDefinition = PostApiPipelineDefinitionsResponses[200];
export type PublishPipelineVersionResult =
  PostApiPipelineDefinitionsByPipelineDefinitionIdVersionsResponses[200];

const pipelineDocumentIssueSchema = z.object({
  code: z.string(),
  path: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

/** One validation error the server reports for a rejected pipeline document. */
export type PipelineDocumentIssue = z.infer<typeof pipelineDocumentIssueSchema>;

type ApiError = {
  title?: string;
  detail?: string;
  code?: string;
  meta?: { [key: string]: unknown };
};

/**
 * Thrown when the API rejects a request. `issues` carries the per-path
 * validation errors of a `PIPELINE_DOCUMENT_INVALID` rejection.
 */
export class PipelineDefinitionsApiError extends Error {
  readonly code: string | undefined;
  readonly issues: readonly PipelineDocumentIssue[];

  constructor(error: ApiError) {
    super(error.detail ?? error.title ?? JSON.stringify(error));
    this.name = "PipelineDefinitionsApiError";
    this.code = error.code;
    this.issues = documentIssuesOf(error.meta);
  }
}

function documentIssuesOf(
  meta: { [key: string]: unknown } | undefined,
): PipelineDocumentIssue[] {
  const errors = meta?.["errors"];
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error) => {
    const parsed = pipelineDocumentIssueSchema.safeParse(error);
    return parsed.success ? [parsed.data] : [];
  });
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) {
    throw new PipelineDefinitionsApiError(result.error as ApiError);
  }
  return result.data as T;
}

export function createPipelineDefinitionsClient(
  baseUrl: string,
): ReturnType<typeof buildPipelineDefinitionsClient> {
  const client = createClient({ baseUrl });
  return buildPipelineDefinitionsClient(new PipelineDefinitions({ client }));
}

const buildPipelineDefinitionsClient = (
  pipelineDefinitions: PipelineDefinitions,
) => ({
  listByProjectId: async (projectId: string, options?: RequestOptions) =>
    unwrap(
      await pipelineDefinitions.listPipelineDefinitions({
        path: { projectId },
        headers: options?.headers,
      }),
    ),
  get: async (pipelineDefinitionId: string, options?: RequestOptions) =>
    unwrap(
      await pipelineDefinitions.getPipelineDefinition({
        path: { pipelineDefinitionId },
        headers: options?.headers,
      }),
    ),
  /** Creates a pipeline; `document`, when given, is published as version 1. */
  create: async (
    input: {
      projectId: string;
      key: string;
      name: string;
      document?: Record<string, unknown>;
    },
    options?: RequestOptions,
  ) =>
    unwrap(
      await pipelineDefinitions.createPipelineDefinition({
        body: input,
        headers: options?.headers,
      }),
    ),
  /**
   * Publishes `document` as the pipeline's next version, which becomes the
   * active one. `published` is false when it matched the latest version.
   */
  publishVersion: async (
    pipelineDefinitionId: string,
    document: Record<string, unknown>,
    options?: RequestOptions,
  ) =>
    unwrap(
      await pipelineDefinitions.publishPipelineDefinitionVersion({
        path: { pipelineDefinitionId },
        body: { document },
        headers: options?.headers,
      }),
    ),
  activateVersion: async (
    pipelineDefinitionId: string,
    version: number,
    options?: RequestOptions,
  ) =>
    unwrap(
      await pipelineDefinitions.activatePipelineDefinitionVersion({
        path: { pipelineDefinitionId, version },
        headers: options?.headers,
      }),
    ),
  listVersions: async (
    pipelineDefinitionId: string,
    options?: RequestOptions,
  ) =>
    unwrap(
      await pipelineDefinitions.listPipelineDefinitionVersions({
        path: { pipelineDefinitionId },
        headers: options?.headers,
      }),
    ),
  getVersion: async (
    pipelineDefinitionId: string,
    version: number,
    options?: RequestOptions,
  ) =>
    unwrap(
      await pipelineDefinitions.getPipelineDefinitionVersion({
        path: { pipelineDefinitionId, version },
        headers: options?.headers,
      }),
    ),
});
