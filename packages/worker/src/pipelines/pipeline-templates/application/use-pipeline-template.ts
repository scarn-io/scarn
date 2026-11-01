/**
 * "Use template": write a pipeline template's rendered source into the
 * pipeline-builder directory as `<pipelineKey>.ts`. The studio's file watcher
 * builds and shows it from there.
 *
 * Step keys are project-wide and the template's prompts name each other by
 * key, so a step-key collision refuses the write. A pipeline-key collision
 * doesn't: the file gets the next free `<pipelineKey>-N` (highest suffix + 1).
 * An existing file is never overwritten. The file name always comes from the
 * template's `pipelineKey`, never from the caller.
 */
import { linkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { PipelineTemplate } from "../domain/pipeline-template";
import { renderPipelineTemplate } from "./render-pipeline-template";

export type PipelineTemplateConflicts = {
  /** Template step keys already defined in the builder directory. */
  takenStepKeys: string[];
  pipelineKeyTaken: boolean;
  /** The key "Use" would write: the template's own, or the next free `-N`. */
  nextPipelineKey: string;
};

/** What's already defined in the builder directory. */
export type ExistingBuilderDefinitions = {
  stepKeys: Iterable<string>;
  pipelineKeys: Iterable<string>;
};

export type UsePipelineTemplateInput = {
  builderDir: string;
  cliVersion: string;
  /** Values by parameter key; checked against the template's parameters. */
  parameterValues: Readonly<Record<string, string>>;
  existing: ExistingBuilderDefinitions;
};

export type UsePipelineTemplateResult =
  | { ok: true; file: string; pipelineKey: string }
  | {
      ok: false;
      reason: "step-keys-taken";
      takenStepKeys: string[];
      message: string;
    }
  | {
      ok: false;
      reason: "invalid-parameters";
      missingParameters: string[];
      unknownParameters: string[];
      message: string;
    };

const MAX_WRITE_ATTEMPTS = 5;

/** Base names of the `.ts` and `.json` files in the builder directory. */
function listFileKeys(builderDir: string): string[] {
  return readdirSync(builderDir)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".json"))
    .map((file) => file.slice(0, -extname(file).length));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `base` when free, otherwise `base-N` one past the highest suffix in use. */
export function nextFreePipelineKey(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) return base;
  const suffix = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let max = 1;
  for (const key of taken) {
    const match = suffix.exec(key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${base}-${String(max + 1)}`;
}

export function checkPipelineTemplateConflicts(
  template: PipelineTemplate,
  builderDir: string,
  existing: ExistingBuilderDefinitions,
): PipelineTemplateConflicts {
  const stepKeys = new Set(existing.stepKeys);
  const pipelineKeys = new Set([
    ...existing.pipelineKeys,
    ...listFileKeys(builderDir),
  ]);
  return {
    takenStepKeys: template.stepKeys.filter((key) => stepKeys.has(key)),
    pipelineKeyTaken: pipelineKeys.has(template.pipelineKey),
    nextPipelineKey: nextFreePipelineKey(template.pipelineKey, pipelineKeys),
  };
}

function validateParameterValues(
  template: PipelineTemplate,
  values: Readonly<Record<string, string>>,
):
  | { ok: true; values: Readonly<Record<string, string>> }
  | Extract<UsePipelineTemplateResult, { reason: "invalid-parameters" }> {
  const known = new Set(template.parameters.map((param) => param.key));
  const unknownParameters = Object.keys(values).filter(
    (key) => !known.has(key),
  );
  const missingParameters = template.parameters
    .filter((param) => param.required && !values[param.key]?.trim())
    .map((param) => param.key);
  if (unknownParameters.length > 0 || missingParameters.length > 0) {
    const parts = [
      ...(missingParameters.length > 0
        ? [`Missing required parameters: ${missingParameters.join(", ")}.`]
        : []),
      ...(unknownParameters.length > 0
        ? [`Unknown parameters: ${unknownParameters.join(", ")}.`]
        : []),
    ];
    return {
      ok: false,
      reason: "invalid-parameters",
      missingParameters,
      unknownParameters,
      message: parts.join(" "),
    };
  }
  return { ok: true, values };
}

/**
 * Writes `content` to `path` only if nothing is there yet: the full content
 * goes to a temp file first, then a hard link publishes it in one step and
 * fails with `EEXIST` rather than replace an existing file.
 */
function writeFileExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function usePipelineTemplate(
  template: PipelineTemplate,
  input: UsePipelineTemplateInput,
): UsePipelineTemplateResult {
  const params = validateParameterValues(template, input.parameterValues);
  if (!params.ok) return params;

  const conflicts = checkPipelineTemplateConflicts(
    template,
    input.builderDir,
    input.existing,
  );
  if (conflicts.takenStepKeys.length > 0) {
    return {
      ok: false,
      reason: "step-keys-taken",
      takenStepKeys: conflicts.takenStepKeys,
      message: `These steps already exist in the pipeline builder: ${conflicts.takenStepKeys.join(", ")}. Rename or remove them before using this template.`,
    };
  }

  const taken = new Set([
    ...input.existing.pipelineKeys,
    ...listFileKeys(input.builderDir),
  ]);
  let pipelineKey = conflicts.nextPipelineKey;
  for (let attempt = 1; ; attempt += 1) {
    const file = `${pipelineKey}.ts`;
    const source = renderPipelineTemplate(template, {
      cliVersion: input.cliVersion,
      parameterValues: params.values,
      pipelineKey,
    });
    if (writeFileExclusive(join(input.builderDir, file), source)) {
      return { ok: true, file, pipelineKey };
    }
    if (attempt >= MAX_WRITE_ATTEMPTS) {
      throw new Error(
        `Couldn't find a free file name for pipeline "${template.pipelineKey}".`,
      );
    }
    taken.add(pipelineKey);
    pipelineKey = nextFreePipelineKey(template.pipelineKey, taken);
  }
}
