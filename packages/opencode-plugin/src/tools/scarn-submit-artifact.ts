import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  ARTIFACT_BUNDLE_LIMITS,
  DEFAULT_ARTIFACT_BUNDLE_ENTRY,
  artifactFileExtension,
  artifactPlatforms,
  describeArtifactFieldProblem,
  isEmbeddableArtifactExtension,
  type ArtifactField,
  type ArtifactFieldProblem,
} from "@scarn/sdk/contracts/artifacts";
import {
  STEP_ARTIFACTS_RELATIVE_DIR,
  buildStepArtifactsDir,
  findSubmittableArtifactFieldsWithProblems,
  readStepArtifactSubmissions,
  writeStepArtifactSubmissions,
} from "@scarn/sdk/contracts/step-artifact-submissions";
import {
  describeAccept,
  formatMiB,
  planBundle,
  planFile,
  relateSourceToDestination,
  storedPathsOverlap,
  type SubmissionPlan,
} from "./_shared/artifact-submission-plan";
import {
  CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  tryLoadCurrentExecutionInfo,
} from "./_shared/current-execution";
import { resolveWorktree } from "./_shared/resolve-worktree";

export const SCARN_SUBMIT_ARTIFACT_TOOL = "scarn-submit-artifact";

type SubmitArtifactInput = {
  path?: unknown;
  field?: unknown;
  name?: unknown;
  entry?: unknown;
};

export type SubmitArtifactResult = {
  ok: true;
  field: string | null;
  stored: string;
  /** Set when a folder was submitted as a bundle. */
  bundle?: { entry: string; fileCount: number; sizeBytes: number };
  warnings: string[];
};

const BUNDLE_GUIDE = [
  "To submit a web page (an HTML report or prototype), submit its folder as a bundle. The folder must be self-contained, with an entry page (index.html unless the field names another):",
  '- use relative paths only (e.g. Vite `base: "./"`) and load nothing from other sites;',
  "- use hash routing (`#/page`); there is no server-side routing;",
  "- don't rely on `localStorage`, `IndexedDB` or cookies; they fail inside the page, so keep state in memory.",
  `A bundle can hold up to ${ARTIFACT_BUNDLE_LIMITS.maxFiles.toLocaleString("en-US")} files, ${formatMiB(ARTIFACT_BUNDLE_LIMITS.maxFileBytes)} per file and ${formatMiB(ARTIFACT_BUNDLE_LIMITS.maxBundleBytes)} in total.`,
].join("\n");

const GENERIC_DESCRIPTION = [
  "Submit a file or folder produced by this step. It is copied into the step's artifacts folder.",
  "If the step declares artifact fields, submit each declared file or folder with `field` set to the field name. Other files and folders can be submitted without `field`, optionally with `name` for the stored name.",
  "Don't put artifact paths in findingsJson; scarn-submit-step-findings fills those fields in.",
  BUNDLE_GUIDE,
].join("\n");

function describeField(field: ArtifactField): string {
  const notes = [
    describeAccept(field),
    field.nullable ? "optional" : "required",
    ...(field.share ? ["shared by link automatically"] : []),
  ];
  const summary = `${field.path} (${notes.join("; ")})`;
  return field.description ? `${summary}: ${field.description}` : summary;
}

function describeSchemaProblems(
  problems: readonly ArtifactFieldProblem[],
): string {
  return problems.map(describeArtifactFieldProblem).join("\n");
}

/**
 * The tool description for a step: its declared artifact fields when the
 * result schema is known, a generic guide otherwise.
 */
export function buildSubmitArtifactDescription(
  resultSchemaJson: Record<string, unknown> | null | undefined,
): string {
  if (resultSchemaJson === undefined) return GENERIC_DESCRIPTION;
  const { fields, problems } =
    findSubmittableArtifactFieldsWithProblems(resultSchemaJson);
  if (problems.length > 0) {
    return [
      "Submit a file or folder produced by this step. This step's artifact fields can't be read, so every submission will be refused:",
      describeSchemaProblems(problems),
    ].join("\n");
  }
  if (fields.length === 0) {
    return [
      "Submit a file or folder produced by this step. This step declares no artifact fields.",
      "Submit files and folders without `field`, optionally with `name` for the stored name.",
      BUNDLE_GUIDE,
    ].join("\n");
  }
  return [
    "Submit a file or folder produced by this step. This step declares:",
    ...fields.map((field) => `- ${describeField(field)}`),
    "Submit declared files and folders with `field`. Don't put artifact paths in findingsJson;",
    "scarn-submit-step-findings fills those fields in.",
    "Other files and folders can be submitted without `field`, optionally with `name` for the stored name.",
    BUNDLE_GUIDE,
  ].join("\n");
}

function describeDeclaredFields(fields: readonly ArtifactField[]): string {
  return fields.length > 0
    ? `This step declares: ${fields.map(describeField).join("; ")}.`
    : "This step declares no artifact fields; submit the file or folder without `field`.";
}

function optionalString(
  value: SubmitArtifactInput["field"],
  key: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`\`${key}\` must be a non-empty string when given.`);
  }
  return value.trim();
}

/**
 * The step's submittable artifact fields, or `null` when `execution.json`
 * can't be read. Refuses a schema whose `x-scarn-artifact` keywords this
 * plugin can't fully read.
 */
async function loadArtifactFields(
  worktree: string,
): Promise<ArtifactField[] | null> {
  const executionInfo = await tryLoadCurrentExecutionInfo(worktree);
  if (!executionInfo) return null;
  const { fields, problems } = findSubmittableArtifactFieldsWithProblems(
    executionInfo.resultSchemaJson,
  );
  if (problems.length > 0) throw new Error(describeSchemaProblems(problems));
  return fields;
}

function resolveDeclaredField(
  fields: readonly ArtifactField[] | null,
  fieldPath: string,
): ArtifactField {
  if (!fields) {
    throw new Error(
      `Can't check \`field: "${fieldPath}"\`: ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} could not be read. Submit it without \`field\` instead.`,
    );
  }
  const field = fields.find((candidate) => candidate.path === fieldPath);
  if (!field) {
    throw new Error(
      `\`${fieldPath}\` is not a declared artifact field. ${describeDeclaredFields(fields)}`,
    );
  }
  return field;
}

function linkOnlyWarning(stored: string): string | null {
  const extension = artifactFileExtension(stored);
  const embeddable = artifactPlatforms.some((platform) =>
    isEmbeddableArtifactExtension(platform, extension),
  );
  if (embeddable) return null;
  const kind = extension ? `${extension} files` : "files without an extension";
  return `No platform embeds ${kind}, so ${stored} will be linked rather than embedded in comments.`;
}

/**
 * Copies a file or folder the agent produced into the step-artifacts folder
 * and records it in `.scarn/current-execution/artifacts.json`. A declared
 * file field is stored as `<field path>.<ext>` and a declared bundle field as
 * the folder `<field path>/`. An undeclared file keeps its basename or uses
 * `name`; an undeclared folder is a bundle stored as `<name>/` (default: the
 * folder's basename) with entry page `entry` (default: `index.html`).
 */
export async function submitArtifact(
  input: SubmitArtifactInput,
  directory: string,
): Promise<SubmitArtifactResult> {
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    throw new Error("`path` must be the path of the file or folder to submit.");
  }
  const submittedPath = input.path.trim();
  const fieldPath = optionalString(input.field, "field");
  const name = optionalString(input.name, "name");
  const entryName = optionalString(input.entry, "entry");
  if (fieldPath && name) {
    throw new Error(
      "Pass either `field` (a declared artifact field) or `name` (an undeclared file or folder), not both. Declared fields are stored under the field name.",
    );
  }

  const worktree = await resolveWorktree(directory);
  const sourcePath = path.resolve(worktree, submittedPath);
  const fields = await loadArtifactFields(worktree);
  const field = fieldPath ? resolveDeclaredField(fields, fieldPath) : null;

  const stats = await stat(sourcePath).catch(() => null);
  if (!stats) {
    throw new Error(
      `${field?.bundle ? "Folder" : "File"} not found: ${sourcePath}`,
    );
  }
  let plan: SubmissionPlan;
  if (stats.isDirectory()) {
    plan = await planBundle({
      field,
      name,
      entryName,
      sourcePath,
      submittedPath,
    });
  } else if (stats.isFile()) {
    plan = planFile({
      field,
      name,
      entryName,
      sourcePath,
      submittedPath,
      size: stats.size,
    });
  } else {
    throw new Error(`Not a regular file or folder: ${sourcePath}`);
  }
  const { stored, entry } = plan;

  const submissions = await readStepArtifactSubmissions(worktree);
  if (!field) {
    const claimedBy = Object.entries(submissions.fields).find(([, item]) =>
      storedPathsOverlap(item.stored, stored),
    );
    if (claimedBy) {
      throw new Error(
        `${stored} would overwrite ${claimedBy[1].stored}, stored for \`${claimedBy[0]}\`. Use a different \`name\`.`,
      );
    }
    const clash = submissions.extra.find(
      (item) =>
        item.stored !== stored && storedPathsOverlap(item.stored, stored),
    );
    if (clash) {
      throw new Error(
        `${stored} would overwrite the earlier submission stored as ${clash.stored}. Use a different \`name\`.`,
      );
    }
  }

  const artifactsDir = buildStepArtifactsDir(worktree);
  const destination = path.join(artifactsDir, stored);
  const relation = await relateSourceToDestination(sourcePath, destination);
  if (relation === "nested") {
    throw new Error(
      `${submittedPath} and ${path.posix.join(STEP_ARTIFACTS_RELATIVE_DIR, stored)} are inside each other. Submit a folder outside ${STEP_ARTIFACTS_RELATIVE_DIR}.`,
    );
  }
  if (relation === "apart") {
    await rm(destination, { recursive: true, force: true });
    await plan.copy(destination);
  }

  const warnings: string[] = [];
  const nextFields = { ...submissions.fields };
  const replacedExtra = submissions.extra.filter((item) =>
    storedPathsOverlap(item.stored, stored),
  );
  let extra = submissions.extra.filter(
    (item) => !storedPathsOverlap(item.stored, stored),
  );

  if (field) {
    const previous = nextFields[field.path];
    if (previous) {
      if (previous.stored !== stored) {
        await rm(path.join(artifactsDir, previous.stored), {
          recursive: true,
          force: true,
        });
      }
      warnings.push(
        `Replaced the earlier submission for \`${field.path}\` (${previous.stored}).`,
      );
    }
    for (const item of replacedExtra) {
      warnings.push(
        `Replaced the earlier undeclared submission stored as ${item.stored}.`,
      );
    }
    nextFields[field.path] = entry;
  } else {
    if (replacedExtra.length > 0) {
      warnings.push(`Replaced the earlier submission stored as ${stored}.`);
    }
    extra = [...extra, entry];
  }

  await writeStepArtifactSubmissions(worktree, { fields: nextFields, extra });

  if (entry.kind === "file") {
    const linkWarning = linkOnlyWarning(stored);
    if (linkWarning) warnings.push(linkWarning);
    return { ok: true, field: field?.path ?? null, stored, warnings };
  }
  return {
    ok: true,
    field: field?.path ?? null,
    stored,
    bundle: {
      entry: entry.entry,
      fileCount: entry.fileCount,
      sizeBytes: entry.sizeBytes,
    },
    warnings,
  };
}

/**
 * The `scarn-submit-artifact` tool, bound to the plugin's directory. Its
 * description lists the current step's declared artifact fields, read from
 * `execution.json` when the plugin loads.
 */
export async function createScarnSubmitArtifactTool(
  directory: string,
): Promise<ToolInfo> {
  const executionInfo = await tryLoadCurrentExecutionInfo(
    await resolveWorktree(directory),
  );
  return {
    name: SCARN_SUBMIT_ARTIFACT_TOOL,
    description: buildSubmitArtifactDescription(
      executionInfo ? executionInfo.resultSchemaJson : undefined,
    ),
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path of the file or folder to submit, absolute or relative to the workspace. It is copied now, so later edits don't change what was submitted; the original stays in place.",
        },
        field: {
          type: "string",
          description:
            "The declared artifact field this file or folder fills in. Submitting the same field again replaces the earlier submission.",
        },
        name: {
          type: "string",
          description:
            "Stored name for an undeclared artifact, relative to the artifacts folder. Defaults to the file's or folder's basename. A folder's name must be a single folder name.",
        },
        entry: {
          type: "string",
          description: `Entry page of an undeclared folder, relative to the folder. Defaults to ${DEFAULT_ARTIFACT_BUNDLE_ENTRY}. Declared bundle fields name their own entry page.`,
        },
      },
      required: ["path"],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: JSON.stringify(
        await submitArtifact(input as SubmitArtifactInput, directory),
        null,
        2,
      ),
    }),
  };
}
