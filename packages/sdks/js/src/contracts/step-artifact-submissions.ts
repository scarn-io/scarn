/**
 * The record of files submitted with `scarn-submit-artifact`
 * (`.scarn/current-execution/artifacts.json`) and the checks that tie it to
 * a step's findings. Shared by the opencode plugin, which fills declared
 * artifact fields in from it, and the worker, which checks the findings file
 * against it before completing the step.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  artifactAcceptsFile,
  artifactFileExtension,
  findArtifactFields,
  findArtifactFieldsWithProblems,
  type ArtifactField,
  type ArtifactFieldProblem,
  type ArtifactJsonSchemaNode,
} from "./artifacts";

export const STEP_ARTIFACTS_RELATIVE_DIR = ".scarn/step-artifacts";
export const STEP_ARTIFACT_SUBMISSIONS_RELATIVE_PATH =
  ".scarn/current-execution/artifacts.json";

type SubmittedArtifactBase = {
  /** Path relative to the step-artifacts folder: a file, or a bundle's folder. */
  readonly stored: string;
  /** The path the agent submitted, as given. */
  readonly sourcePath: string;
  /** The file's size, or the total size of a bundle's files. */
  readonly sizeBytes: number;
};

export type SubmittedArtifactFile = SubmittedArtifactBase & {
  readonly kind: "file";
};

export type SubmittedArtifactBundle = SubmittedArtifactBase & {
  readonly kind: "bundle";
  /** The entry page, relative to the bundle folder. */
  readonly entry: string;
  readonly fileCount: number;
};

export type SubmittedArtifact = SubmittedArtifactFile | SubmittedArtifactBundle;

export type StepArtifactSubmissions = {
  readonly fields: Readonly<Record<string, SubmittedArtifact>>;
  readonly extra: readonly SubmittedArtifact[];
};

export const EMPTY_STEP_ARTIFACT_SUBMISSIONS: StepArtifactSubmissions = {
  fields: {},
  extra: [],
};

/** Declared artifact fields that can be filled in; v1 skips fields inside arrays. */
export function findSubmittableArtifactFields(
  schema: ArtifactJsonSchemaNode | null | undefined,
): ArtifactField[] {
  return findArtifactFields(schema).filter((field) => !field.inArray);
}

/**
 * `findSubmittableArtifactFields` plus each field's keyword problems, for
 * callers that must refuse a schema they don't fully understand.
 */
export function findSubmittableArtifactFieldsWithProblems(
  schema: ArtifactJsonSchemaNode | null | undefined,
): {
  readonly fields: ArtifactField[];
  readonly problems: ArtifactFieldProblem[];
} {
  const { fields, problems } = findArtifactFieldsWithProblems(schema);
  return { fields: fields.filter((field) => !field.inArray), problems };
}

const submittedArtifactBaseShape = {
  stored: z.string().min(1),
  sourcePath: z.string(),
  sizeBytes: z.number(),
};

const submittedArtifactSchema = z.union([
  z.object({
    ...submittedArtifactBaseShape,
    kind: z.literal("bundle"),
    entry: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
  }),
  z.object({
    ...submittedArtifactBaseShape,
    kind: z.literal("file").default("file"),
  }),
]);

const stepArtifactSubmissionsSchema = z.object({
  fields: z.record(z.string(), submittedArtifactSchema),
  extra: z.array(submittedArtifactSchema),
});

export function buildStepArtifactsDir(workspacePath: string): string {
  return path.join(workspacePath, STEP_ARTIFACTS_RELATIVE_DIR);
}

export function buildStepArtifactSubmissionsPath(
  workspacePath: string,
): string {
  return path.join(workspacePath, STEP_ARTIFACT_SUBMISSIONS_RELATIVE_PATH);
}

/** Reads `artifacts.json`; a missing file means nothing was submitted. */
export async function readStepArtifactSubmissions(
  workspacePath: string,
): Promise<StepArtifactSubmissions> {
  let raw: string;
  try {
    raw = await readFile(
      buildStepArtifactSubmissionsPath(workspacePath),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STEP_ARTIFACT_SUBMISSIONS;
    }
    throw error;
  }
  const parsed = stepArtifactSubmissionsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${STEP_ARTIFACT_SUBMISSIONS_RELATIVE_PATH} is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export async function writeStepArtifactSubmissions(
  workspacePath: string,
  submissions: StepArtifactSubmissions,
): Promise<void> {
  const filePath = buildStepArtifactSubmissionsPath(workspacePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(submissions, null, 2)}\n`,
    "utf8",
  );
}

/** A step's findings as parsed JSON. */
export type StepFindingsJson =
  | string
  | number
  | boolean
  | null
  | StepFindingsJson[]
  | { [key: string]: StepFindingsJson };

type JsonObject = { [key: string]: StepFindingsJson };

function isJsonObject(
  value: StepFindingsJson | undefined,
): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPath(
  root: StepFindingsJson,
  segments: readonly string[],
): StepFindingsJson | undefined {
  let current: StepFindingsJson | undefined = root;
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Sets a dot-path value. Missing parent objects are created only for a
 * non-null value, so an absent optional parent stays absent.
 */
function writePath(
  root: JsonObject,
  segments: readonly string[],
  value: string | null,
): void {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (isJsonObject(next)) {
      current = next;
      continue;
    }
    if (value === null || next !== undefined) return;
    const created: JsonObject = {};
    current[segment] = created;
    current = created;
  }
  const last = segments.at(-1);
  if (last !== undefined) current[last] = value;
}

function submitHint(field: string): string {
  return `call \`scarn-submit-artifact\` with \`field: "${field}"\``;
}

export type ApplyArtifactSubmissionsMode =
  /**
   * The plugin: a value the agent wrote in an artifact field is rejected, and
   * every field is filled in from the submissions.
   */
  | "fill"
  /**
   * The worker: the findings were already filled in, so each artifact field
   * must equal what the submissions record.
   */
  | "verify";

export type ApplyArtifactSubmissionsResult = {
  /** The findings with every artifact field filled in (a copy). */
  readonly findings: StepFindingsJson;
  readonly problems: readonly string[];
};

/**
 * Fills each declared artifact field from `submissions`: the stored name when
 * the field was submitted, `null` when it wasn't and the field is nullable,
 * and a problem when it wasn't and the field is required. Collects every
 * problem rather than stopping at the first.
 */
export function applyArtifactSubmissions(input: {
  readonly findings: StepFindingsJson;
  readonly fields: readonly ArtifactField[];
  readonly submissions: StepArtifactSubmissions;
  readonly mode: ApplyArtifactSubmissionsMode;
}): ApplyArtifactSubmissionsResult {
  const findings = structuredClone(input.findings);
  const problems: string[] = [];
  if (!isJsonObject(findings)) return { findings, problems };

  for (const field of input.fields) {
    const segments = field.path.split(".");
    const current = readPath(findings, segments);
    const submitted = input.submissions.fields[field.path];
    const expected = submitted?.stored ?? null;

    if (input.mode === "fill" && current !== undefined && current !== null) {
      problems.push(
        `\`${field.path}\` is filled in from submitted artifacts. Remove it and ${submitHint(field.path)}.`,
      );
    }
    if (
      input.mode === "verify" &&
      (current ?? null) !== expected &&
      (submitted || field.nullable)
    ) {
      problems.push(
        `\`${field.path}\` is ${JSON.stringify(current ?? null)} in the findings, but the submitted artifacts record ${JSON.stringify(expected)}.`,
      );
    }

    if (!submitted && !field.nullable) {
      problems.push(
        `\`${field.path}\` is required. Save the ${field.bundle ? "folder" : "file"} and ${submitHint(field.path)} first.`,
      );
      continue;
    }
    writePath(findings, segments, expected);
  }

  return { findings, problems };
}

type StoredArtifactState =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly empty: boolean }
  | {
      readonly kind: "directory";
      readonly empty: boolean;
      readonly hasEntry: boolean;
    };

async function readStoredArtifact(
  absolutePath: string,
  entry: string | null,
): Promise<StoredArtifactState> {
  const stats = await stat(absolutePath).catch(() => null);
  if (stats?.isFile()) return { kind: "file", empty: stats.size === 0 };
  if (!stats?.isDirectory()) return { kind: "missing" };
  const children = await readdir(absolutePath).catch(() => []);
  const entryStats = entry
    ? await stat(path.join(absolutePath, entry)).catch(() => null)
    : null;
  return {
    kind: "directory",
    empty: children.length === 0,
    hasEntry: !!entryStats?.isFile(),
  };
}

/**
 * Why the stored artifact at `relativePath` can't fill `field`, or null.
 * A file field needs a non-empty file; a bundle field needs a non-empty
 * folder holding its entry page.
 */
function storedArtifactProblem(
  field: ArtifactField,
  relativePath: string,
  state: StoredArtifactState,
): string | null {
  if (field.bundle) {
    if (state.kind === "file") {
      return `${relativePath} is a file, and a bundle field needs a folder`;
    }
    if (state.kind === "missing" || state.empty) {
      return `${relativePath} is missing or empty`;
    }
    if (!state.hasEntry) {
      return `${relativePath} has no entry page ${field.bundle.entry}`;
    }
    return null;
  }
  if (state.kind === "directory") {
    return `${relativePath} is a folder, and a file field needs a file`;
  }
  if (state.kind === "missing" || state.empty) {
    return `${relativePath} is missing or empty`;
  }
  return null;
}

/**
 * Checks every submitted field's stored artifact is still there: a
 * non-empty file for a file field, a non-empty folder holding the entry page
 * for a bundle field.
 */
export async function checkSubmittedArtifactFiles(input: {
  readonly workspacePath: string;
  readonly fields: readonly ArtifactField[];
  readonly submissions: StepArtifactSubmissions;
}): Promise<string[]> {
  const artifactsDir = buildStepArtifactsDir(input.workspacePath);
  const problems: string[] = [];
  for (const field of input.fields) {
    const submitted = input.submissions.fields[field.path];
    if (!submitted) continue;
    const relativePath = path.posix.join(
      STEP_ARTIFACTS_RELATIVE_DIR,
      submitted.stored,
    );
    const again = field.bundle
      ? "Save the folder again"
      : "Save the file again";
    const expectedKind = field.bundle ? "bundle" : "file";
    if (submitted.kind !== expectedKind) {
      problems.push(
        `\`${field.path}\` is a ${expectedKind} field, but ${submitted.stored} was submitted as a ${submitted.kind}. ${again} and ${submitHint(field.path)}.`,
      );
      continue;
    }
    const state = await readStoredArtifact(
      path.join(artifactsDir, submitted.stored),
      field.bundle?.entry ?? null,
    );
    const problem = storedArtifactProblem(field, relativePath, state);
    if (problem) {
      problems.push(
        `\`${field.path}\` was submitted as ${submitted.stored}, but ${problem}. ${again} and ${submitHint(field.path)}.`,
      );
    }
  }
  return problems;
}

function isInsideArtifactsDir(value: string): boolean {
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    !value.endsWith("/")
  );
}

/**
 * Checks the artifact fields a code step returned (`Artifact.path(...)`
 * values): each must be a path inside the step-artifacts folder naming a
 * non-empty file with an accepted extension, or, for a bundle field, a
 * non-empty folder holding the entry page. `null` and absent values are left
 * to the schema check.
 */
export async function checkReturnedArtifactPaths(input: {
  readonly workspacePath: string;
  readonly fields: readonly ArtifactField[];
  readonly findings: StepFindingsJson;
}): Promise<string[]> {
  const artifactsDir = buildStepArtifactsDir(input.workspacePath);
  const problems: string[] = [];
  for (const field of input.fields) {
    const value = readPath(input.findings, field.path.split("."));
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !isInsideArtifactsDir(value)) {
      problems.push(
        `\`${field.path}\` must be a path relative to ${STEP_ARTIFACTS_RELATIVE_DIR} (use \`Artifact.path("<name>")\`), got ${JSON.stringify(value)}.`,
      );
      continue;
    }
    const state = await readStoredArtifact(
      path.join(artifactsDir, value),
      field.bundle?.entry ?? null,
    );
    const problem = storedArtifactProblem(
      field,
      path.posix.join(STEP_ARTIFACTS_RELATIVE_DIR, value),
      state,
    );
    if (problem) {
      problems.push(`\`${field.path}\` is ${value}, but ${problem}.`);
      continue;
    }
    if (!field.bundle && !artifactAcceptsFile(field.accept, value)) {
      problems.push(
        `\`${field.path}\` accepts ${field.accept.join(", ")}, but ${value} has ${artifactFileExtension(value) || "no extension"}.`,
      );
    }
  }
  return problems;
}
