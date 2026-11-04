import type { PipelineGraphSnapshot } from "../graph/studio-graph-types";

/**
 * Typed client for the studio server's template endpoints (see
 * `@scarn/worker`'s `run-pipeline-studio-server.ts`). The shapes mirror the
 * server's `list-pipeline-templates.ts`, `build-pipeline-template-preview.ts`
 * and `use-pipeline-template.ts`; the UI never imports `@scarn/worker`.
 */

export type TemplateParameter = {
  key: string;
  label: string;
  description?: string | null;
  type: "text" | "textarea";
  required: boolean;
  placeholder?: string | null;
};

export type TemplateEntryKind = "pipeline" | "automation";

/** What the template's file defines as its entry point, and under which key. */
export type TemplateEntry = {
  kind: TemplateEntryKind;
  key: string;
};

/** The names a "Use" would collide with in the builder directory right now. */
export type TemplateConflicts = {
  takenStepKeys: string[];
  entryKeyTaken: boolean;
  /** The entry key a Use would write: the template's own, or the next free `-N`. */
  nextEntryKey: string;
};

export type PipelineTemplateCard = {
  key: string;
  name: string;
  summary: string;
  tags: string[];
  entry: TemplateEntry;
  /** Steps the file exports. */
  stepCount: number;
  parameters: TemplateParameter[];
  conflicts: TemplateConflicts;
};

export type TemplateStepRepoAccess =
  | { mode: "none" }
  | { mode: "readOnly" }
  | {
      mode: "readWrite";
      message?: string | null;
      onPushFailure?: "fail" | "warn";
    };

export type TemplateStepPreview = {
  key: string;
  name: string;
  description: string | null;
  prompt: string | null;
  runtime: {
    executionMode: "workspace" | "no_workspace";
    devcontainerConfigPath: string | null;
    managedRuntime: string | null;
  };
  repo: TemplateStepRepoAccess | null;
  workItemPermissions: string[];
  maxTurns: number | null;
  inputSchema: Record<string, unknown> | null;
  resultSchema: Record<string, unknown> | null;
};

export type TemplatePreview = {
  /** `null` for an automation entry, or when the template failed to build. */
  pipeline: PipelineGraphSnapshot | null;
  steps: TemplateStepPreview[];
  errors: string[];
};

export type TemplateDetail = PipelineTemplateCard & {
  descriptionMarkdown: string;
  stepKeys: string[];
  preview: TemplatePreview;
};

export type UseTemplateResult =
  | { status: "ok"; file: string; entry: TemplateEntry }
  | { status: "stepKeysTaken"; error: string; takenStepKeys: string[] }
  | {
      status: "invalidParameters";
      error: string;
      missingParameters: string[];
      unknownParameters: string[];
    }
  | { status: "error"; httpStatus: number; error: string };

/** A non-2xx response the caller didn't expect, with the server's `error` text. */
export class TemplatesApiError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "TemplatesApiError";
  }
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string"
    ? body.error
    : `Request failed with status ${String(response.status)}.`;
}

export async function fetchTemplates(
  signal?: AbortSignal,
): Promise<PipelineTemplateCard[]> {
  const response = await fetch("/api/templates", { signal });
  if (!response.ok) {
    throw new TemplatesApiError(response.status, await readError(response));
  }
  return (await response.json()) as PipelineTemplateCard[];
}

/** `null` when the server has no template with this key (404). */
export async function fetchTemplate(
  key: string,
  signal?: AbortSignal,
): Promise<TemplateDetail | null> {
  const response = await fetch(`/api/templates/${encodeURIComponent(key)}`, {
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new TemplatesApiError(response.status, await readError(response));
  }
  return (await response.json()) as TemplateDetail;
}

/**
 * Writes the template into the builder directory. Expected refusals (409 step
 * keys taken, 422 bad parameters) come back as results, not exceptions;
 * anything else is `status: "error"`.
 */
export async function postUseTemplate(
  key: string,
  parameterValues: Record<string, string>,
): Promise<UseTemplateResult> {
  const response = await fetch(
    `/api/templates/${encodeURIComponent(key)}/use`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parameterValues }),
    },
  );
  if (response.ok) {
    const body = (await response.json()) as {
      file: string;
      entry: TemplateEntry;
    };
    return { status: "ok", file: body.file, entry: body.entry };
  }
  if (response.status === 409) {
    const body = (await response.json()) as {
      error: string;
      takenStepKeys: string[];
    };
    return {
      status: "stepKeysTaken",
      error: body.error,
      takenStepKeys: body.takenStepKeys,
    };
  }
  if (response.status === 422) {
    const body = (await response.json()) as {
      error: string;
      missingParameters: string[];
      unknownParameters: string[];
    };
    return {
      status: "invalidParameters",
      error: body.error,
      missingParameters: body.missingParameters,
      unknownParameters: body.unknownParameters,
    };
  }
  return {
    status: "error",
    httpStatus: response.status,
    error: await readError(response),
  };
}
