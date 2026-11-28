import { z } from "zod";
import {
  ARTIFACT_SCHEMA_KEYWORD,
  DEFAULT_ARTIFACT_BUNDLE_ENTRY,
  artifactBundleEntryProblem,
  type ArtifactSchemaKeyword,
} from "../../contracts/artifacts";
import {
  buildArtifactMarker,
  type ArtifactMarkerRef,
} from "../../contracts/artifact-markers";

export const ARTIFACT_BRAND = "ScarnArtifact";
export type ArtifactBrand = typeof ARTIFACT_BRAND;

/** The value an artifact field holds: a path relative to `artifactsDir`. */
export type ArtifactPath = string & z.$brand<ArtifactBrand>;

export type ArtifactSchema = z.core.$ZodBranded<z.ZodString, ArtifactBrand>;

/**
 * Extension presets for `artifact({ accept })`. They expand to plain
 * extension lists when the step is defined; the server never sees the names.
 */
export const ArtifactTypes = {
  video: [".mp4", ".webm", ".mov"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".svg"],
} as const;

export type ArtifactOptions = {
  /**
   * File extensions the field accepts, e.g. `[".mp4", ".webm"]` or
   * `[...ArtifactTypes.video, ".gif"]`. Omitted or empty accepts any file.
   */
  readonly accept?: readonly string[];
};

const EXTENSION_PATTERN = /^\.[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

function describeEntry(entry: string): string {
  const cleaned = entry
    .trim()
    .toLowerCase()
    .replace(/^\*?\.?/, "");
  return cleaned && EXTENSION_PATTERN.test(`.${cleaned}`)
    ? ` Did you mean \`.${cleaned}\`?`
    : "";
}

/**
 * Validates and normalises an `accept` list: every entry must be a
 * lower-case extension with a leading dot. Duplicates are dropped and order
 * is kept.
 */
export function normalizeArtifactAccept(
  accept: readonly string[] | undefined,
): string[] {
  if (accept === undefined) return [];
  const problems: string[] = [];
  const out: string[] = [];
  for (const entry of accept) {
    if (typeof entry !== "string") {
      problems.push(`${JSON.stringify(entry)} is not a string.`);
      continue;
    }
    if (!entry.startsWith(".")) {
      problems.push(
        `"${entry}" must be a file extension starting with a dot.${describeEntry(entry)}`,
      );
      continue;
    }
    if (entry !== entry.toLowerCase()) {
      problems.push(`"${entry}" must be lower-case.${describeEntry(entry)}`);
      continue;
    }
    if (!EXTENSION_PATTERN.test(entry)) {
      problems.push(`"${entry}" is not a valid file extension.`);
      continue;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  if (problems.length > 0) {
    throw new Error(`artifact({ accept }): ${problems.join(" ")}`);
  }
  return out;
}

function artifactFile(options: ArtifactOptions = {}): ArtifactSchema {
  return artifactSchema({ accept: normalizeArtifactAccept(options.accept) });
}

function artifactSchema(keyword: ArtifactSchemaKeyword): ArtifactSchema {
  return z
    .string()
    .brand<ArtifactBrand>()
    .meta({ [ARTIFACT_SCHEMA_KEYWORD]: keyword });
}

export type ArtifactBundleOptions = {
  /** The bundle's entry page, relative to its folder. Defaults to `index.html`. */
  readonly entry?: string;
  /**
   * Share the bundle automatically once it is ready. Defaults to false. Only
   * step definitions (written by project admins) can turn this on.
   */
  readonly share?: boolean;
};

/**
 * A result field holding a folder of files the step produced, opened at its
 * entry page (an HTML report, say). The field's value is the folder's path
 * relative to `artifactsDir`.
 *
 * Serialises to `{ "type": "string", "x-scarn-artifact": { "accept": [],
 * "bundle": { "entry": "index.html" } } }`, plus `"share": true` when set.
 */
function artifactBundle(options: ArtifactBundleOptions = {}): ArtifactSchema {
  const entry = options.entry ?? DEFAULT_ARTIFACT_BUNDLE_ENTRY;
  const problem = artifactBundleEntryProblem(entry);
  if (problem) throw new Error(`artifact.bundle({ entry }): ${problem}.`);
  return artifactSchema({
    accept: [],
    bundle: { entry },
    ...(options.share === true ? { share: true } : {}),
  });
}

/**
 * A result field holding a file the step produced. The field's value is the
 * file's path relative to `artifactsDir`; agents fill it with
 * `scarn-submit-artifact` and code steps return `Artifact.path(...)`.
 * `artifact.bundle(...)` declares a folder instead.
 *
 * Serialises to `{ "type": "string", "x-scarn-artifact": { "accept": [...] } }`.
 */
export const artifact: typeof artifactFile & {
  readonly bundle: typeof artifactBundle;
} = Object.assign(artifactFile, { bundle: artifactBundle });

/** An artifact field in a step's result: `path` is its dotted result path. */
export type StepArtifactRef = {
  readonly step: { readonly key: string };
  readonly path: string;
};

/**
 * What an artifact marker points at: an artifact field in a step's result
 * (required) or a name/glob relative to `artifactsDir` (optional).
 */
export type ArtifactMarkerTarget = StepArtifactRef | string;

const toMarkerRef = (target: ArtifactMarkerTarget): ArtifactMarkerRef =>
  typeof target === "string"
    ? { type: "path", pattern: target }
    : {
        type: "signal",
        stepKey: target.step.key,
        signalKey: target.path,
      };

export const Artifact = {
  /** Brands a path relative to `artifactsDir` for a code step's artifact field. */
  path(relativePath: string): ArtifactPath {
    return relativePath as ArtifactPath;
  },
  /**
   * A marker that shows the artifact inline in a work item comment where the
   * platform can, and links to it otherwise. Put it in its own paragraph.
   */
  embed(target: ArtifactMarkerTarget, options: { caption: string }): string {
    return buildArtifactMarker("embed", toMarkerRef(target), options.caption);
  },
  /** A marker that links to the artifact. Put it in its own paragraph. */
  link(target: ArtifactMarkerTarget, options: { label: string }): string {
    return buildArtifactMarker("link", toMarkerRef(target), options.label);
  },
} as const;
