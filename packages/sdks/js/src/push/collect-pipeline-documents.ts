// The built pipeline documents (`<key>.json`, written by `scarn pipelines
// build`) in a pipeline-builder directory. Offline, like
// `collect-definitions.ts`, so a bad file fails a push before its first write.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/** JSON files in the builder directory that are tooling config, not pipelines. */
const NON_PIPELINE_JSON = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "jsconfig.json",
  "deno.json",
]);

const pipelineDocumentSchema = z.looseObject({ nodes: z.unknown() });
const documentHeaderSchema = z.object({
  key: z.string().min(1),
  title: z.string().optional(),
});

export type PipelineDocumentFile = {
  /** The file name, relative to the builder directory. */
  readonly file: string;
  readonly key: string;
  readonly title: string | undefined;
  /** The parsed document, sent to the server as-is. */
  readonly document: Record<string, unknown>;
};

/**
 * Every `.json` file in `dir` that holds a pipeline document (an object with
 * `nodes`), sorted by file name. Other JSON is skipped. Throws on a file that
 * isn't valid JSON, a document without a `key`, or two files with one `key`.
 */
export function collectPipelineDocuments(dir: string): PipelineDocumentFile[] {
  const absDir = resolve(dir);
  const files = readdirSync(absDir)
    .filter((file) => file.endsWith(".json") && !NON_PIPELINE_JSON.has(file))
    .sort();

  const byKey = new Map<string, PipelineDocumentFile>();
  for (const file of files) {
    const parsed = pipelineDocumentSchema.safeParse(
      parseJsonFile(join(absDir, file), file),
    );
    if (!parsed.success) continue;
    const document: Record<string, unknown> = parsed.data;

    const header = documentHeaderSchema.safeParse(document);
    if (!header.success) {
      throw new Error(
        `${file} has no "key": every pipeline document names the pipeline it publishes to.`,
      );
    }
    const { key, title } = header.data;
    const existing = byKey.get(key);
    if (existing) {
      throw new Error(
        `${existing.file} and ${file} are both pipeline "${key}". Delete the stale one and build again.`,
      );
    }
    byKey.set(key, { file, key, title, document });
  }
  return [...byKey.values()];
}

function parseJsonFile(path: string, file: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
