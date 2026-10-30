import { readFileSync } from "node:fs";
import { z } from "zod";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import {
  formatValidationError,
  validatePipeline,
  type ValidationResult,
} from "@scarn/shared-core/pipelines";
import type { PipelineDocumentIssue } from "@scarn/sdk/definitions/pipelines";
import { CliError } from "./cli-error";

/**
 * The pure half of the JSON pipeline commands (`validate`, `publish`,
 * `activate`, `run`, `pull --key`): reading a document file, building the
 * step catalog the validator checks it against, and finding a pipeline by key.
 * The commands in `commands/pipelines-documents.ts` wire these to the API.
 */

const documentHeaderSchema = z.object({
  key: z.string().min(1),
  title: z.string().optional(),
});

export type PipelineDocumentFile = {
  /** The parsed document, sent to the server as-is. */
  document: Record<string, unknown>;
  key: string;
  title: string | undefined;
};

export function readPipelineDocumentFile(path: string): PipelineDocumentFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(
      "pipeline_file_unreadable",
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parsePipelineDocumentText(path, text);
}

export function parsePipelineDocumentText(
  path: string,
  text: string,
): PipelineDocumentFile {
  const parsed = z
    .record(z.string(), z.unknown())
    .safeParse(parseJson(path, text));
  if (!parsed.success) {
    throw new CliError(
      "pipeline_file_unreadable",
      `${path} is not a pipeline document: expected a JSON object.`,
    );
  }
  const header = documentHeaderSchema.safeParse(parsed.data);
  if (!header.success) {
    throw new CliError(
      "pipeline_file_unreadable",
      `${path} has no "key": every pipeline document names the pipeline it publishes to.`,
    );
  }
  return {
    document: parsed.data,
    key: header.data.key,
    title: header.data.title,
  };
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      "pipeline_file_unreadable",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The fields of a listed step definition the catalog is built from. */
export type CatalogStepDefinition = {
  key: string;
  version: number;
  status: "draft" | "active" | "archived";
  inputSchemaJson: Record<string, unknown>;
  /** Null for a conversation step; the generated SDK types a nullable object as `unknown`. */
  resultSchemaJson: unknown;
  errors: string[];
};

const resultSchemaJsonSchema = z.record(z.string(), z.unknown()).nullable();

/**
 * The latest active version of each step key — the same step definitions the
 * server pins and validates against when the document is published.
 */
export function buildStepCatalog(
  steps: readonly CatalogStepDefinition[],
): StepCatalog {
  const latest = new Map<string, CatalogStepDefinition>();
  for (const step of steps) {
    if (step.status !== "active") continue;
    const current = latest.get(step.key);
    if (!current || step.version > current.version) {
      latest.set(step.key, step);
    }
  }
  return Object.fromEntries(
    [...latest.values()].map((step) => [
      step.key,
      {
        inputSchema: step.inputSchemaJson,
        resultSchema: resultSchemaJsonSchema.parse(step.resultSchemaJson),
        errors: step.errors,
      },
    ]),
  );
}

export function validatePipelineDocument(
  document: Record<string, unknown>,
  steps: readonly CatalogStepDefinition[],
): ValidationResult {
  return validatePipeline(document, buildStepCatalog(steps));
}

/** One line per issue, in the same `<path>: <message>. <hint>` form as the server. */
export function formatDocumentIssues(
  issues: readonly Pick<PipelineDocumentIssue, "path" | "message" | "hint">[],
): string[] {
  return issues.map(formatValidationError);
}

export function findPipelineByKey<T extends { key: string }>(
  pipelines: readonly T[],
  key: string,
): T | undefined {
  return pipelines.find((pipeline) => pipeline.key === key);
}

const versionDocumentSchema = z.object({
  version: z.number(),
  definition: z.record(z.string(), z.unknown()),
});

export type PipelineVersionDocument = z.infer<typeof versionDocumentSchema>;

/**
 * The active version of a listed pipeline, or `undefined` when it has none.
 * Parsed because the generated client types the nullable `currentVersion` as
 * `T | unknown`.
 */
export function activeVersionOf(pipeline: {
  currentVersion: unknown;
}): PipelineVersionDocument | undefined {
  const parsed = versionDocumentSchema.safeParse(pipeline.currentVersion);
  return parsed.success ? parsed.data : undefined;
}
