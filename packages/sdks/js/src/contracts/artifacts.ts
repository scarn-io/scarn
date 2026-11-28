/**
 * Artifact contract shared by the SDK, the opencode plugin, the worker and
 * core. Everything here works on JSON Schema only (the `x-scarn-artifact`
 * keyword), never on Zod schemas, so the server can use it without knowing
 * how a step was authored.
 */
import { z } from "zod";

export const artifactKindSchema = z.enum([
  "generic",
  "playwright-trace",
  "video",
  "image",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const ARTIFACT_SCHEMA_KEYWORD = "x-scarn-artifact";

/** The entry page a bundle field gets when it doesn't name one. */
export const DEFAULT_ARTIFACT_BUNDLE_ENTRY = "index.html";

const MIB = 1024 * 1024;

export type ArtifactBundleLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxBundleBytes: number;
};

/** Default bundle limits. The server may be configured with others. */
export const ARTIFACT_BUNDLE_LIMITS: ArtifactBundleLimits = Object.freeze({
  maxFiles: 1_000,
  maxFileBytes: 100 * MIB,
  maxBundleBytes: 250 * MIB,
});

export type ArtifactBundleKeyword = { readonly entry: string };

/**
 * The stored `x-scarn-artifact` keyword. `bundle` marks a bundle field (a
 * folder with an entry page) and is omitted for file fields; `share` is only
 * written when true.
 */
export type ArtifactSchemaKeyword = {
  readonly accept: readonly string[];
  readonly bundle?: ArtifactBundleKeyword;
  readonly share?: boolean;
};

const KNOWN_ARTIFACT_KEYWORD_KEYS: readonly string[] = [
  "accept",
  "bundle",
  "share",
];
const KNOWN_ARTIFACT_BUNDLE_KEYS: readonly string[] = ["entry"];

/**
 * Appended to every problem with an `x-scarn-artifact` keyword this SDK
 * can't read, so an old plugin or worker fails clearly on a newer step.
 */
export const ARTIFACT_KEYWORD_NEWER_WORKER_HINT =
  "this step needs a newer Scarn worker";

/**
 * Why a bundle entry page is invalid, or null when it is a relative path
 * inside the bundle (no `.`/`..`/empty segments, no backslashes) ending in
 * `.html`.
 */
export function artifactBundleEntryProblem(entry: string): string | null {
  const segments = entry.split("/");
  if (
    entry.trim() === "" ||
    entry.includes("\\") ||
    entry.startsWith("/") ||
    segments.some((segment) => ["", ".", ".."].includes(segment))
  ) {
    return `entry "${entry}" must be a relative path inside the bundle, e.g. "index.html"`;
  }
  if (!entry.toLowerCase().endsWith(".html")) {
    return `entry "${entry}" must be an .html file`;
  }
  return null;
}

/** The keyword as read: defaults applied, plus anything this SDK can't read. */
export type ReadArtifactKeyword = {
  readonly accept: readonly string[];
  readonly bundle: ArtifactBundleKeyword | null;
  readonly share: boolean;
  /** Each unknown or malformed part of the keyword, e.g. `unknown key "foo"`. */
  readonly problems: readonly string[];
};

/** A JSON Schema node. `true` / `false` are the boolean schema forms. */
export type ArtifactJsonSchemaNode =
  boolean | { readonly [key: string]: unknown };

/** A declared artifact field in a step's result schema. */
export type ArtifactField = {
  /**
   * Dot path of the field. Array items appear as `[]`, e.g. `shots[]` or
   * `runs[].video`.
   */
  readonly path: string;
  /** Lower-case extensions with a leading dot. Empty accepts any file. */
  readonly accept: readonly string[];
  readonly nullable: boolean;
  readonly description: string | null;
  /** True when the field sits inside an array, which v1 does not support. */
  readonly inArray: boolean;
  /** Set for a bundle field: its value is a folder holding `entry`. */
  readonly bundle: ArtifactBundleKeyword | null;
  /** Whether a bundle field is shared automatically. Always false for files. */
  readonly share: boolean;
};

/** A problem with a declared artifact field's keyword. */
export type ArtifactFieldProblem = {
  readonly path: string;
  readonly message: string;
};

export const artifactPlatforms = ["github", "jira", "bitbucket"] as const;
export type ArtifactPlatform = (typeof artifactPlatforms)[number];

/**
 * Extensions each platform can show inline in a comment. Anything else is
 * linked to its Scarn artifact page. GitHub and Bitbucket link everything
 * in v1.
 */
export const EMBEDDABLE_ARTIFACT_EXTENSIONS: Readonly<
  Record<ArtifactPlatform, readonly string[]>
> = {
  jira: [".png", ".gif", ".mp4", ".webm"],
  github: [],
  bitbucket: [],
};

export function isEmbeddableArtifactExtension(
  platform: ArtifactPlatform,
  extension: string,
): boolean {
  return EMBEDDABLE_ARTIFACT_EXTENSIONS[platform].includes(
    extension.toLowerCase(),
  );
}

/** The lower-cased extension of a file name, with its dot; `""` when none. */
export function artifactFileExtension(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** Whether a file name matches an `accept` list. An empty list accepts any file. */
export function artifactAcceptsFile(
  accept: readonly string[],
  fileName: string,
): boolean {
  if (accept.length === 0) return true;
  return accept.includes(artifactFileExtension(fileName));
}

function asRecord(
  node: ArtifactJsonSchemaNode | undefined,
): { readonly [key: string]: unknown } | null {
  return typeof node === "object" ? node : null;
}

function isNullSchema(node: ArtifactJsonSchemaNode): boolean {
  return asRecord(node)?.["type"] === "null";
}

function schemaBranches(
  record: { readonly [key: string]: unknown },
  keyword: "anyOf" | "oneOf" | "allOf",
): ArtifactJsonSchemaNode[] {
  const value = record[keyword];
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (entry): entry is ArtifactJsonSchemaNode =>
      typeof entry === "boolean" ||
      (typeof entry === "object" && entry !== null && !Array.isArray(entry)),
  );
}

function readBundleKeyword(
  value: ArtifactJsonSchemaNode | undefined,
  problems: string[],
): ArtifactBundleKeyword | null {
  if (value === undefined) return null;
  const bundle = asRecord(value);
  if (!bundle || Array.isArray(value)) {
    problems.push(`"bundle" must be an object`);
    return null;
  }
  for (const key of Object.keys(bundle)) {
    if (!KNOWN_ARTIFACT_BUNDLE_KEYS.includes(key)) {
      problems.push(`unknown key "bundle.${key}"`);
    }
  }
  const entry = bundle["entry"];
  if (entry !== undefined && typeof entry !== "string") {
    problems.push(`"bundle.entry" must be a string`);
  }
  return {
    entry:
      typeof entry === "string" && entry.trim() !== ""
        ? entry
        : DEFAULT_ARTIFACT_BUNDLE_ENTRY,
  };
}

/**
 * Reads the `x-scarn-artifact` keyword on this exact node. Keys this SDK
 * doesn't know, and known keys with the wrong type, are reported in
 * `problems` rather than ignored.
 */
export function readArtifactKeyword(
  node: ArtifactJsonSchemaNode,
): ReadArtifactKeyword | null {
  const record = asRecord(node);
  const keyword = asRecord(
    record?.[ARTIFACT_SCHEMA_KEYWORD] as ArtifactJsonSchemaNode | undefined,
  );
  if (!keyword) return null;
  const problems: string[] = [];
  for (const key of Object.keys(keyword)) {
    if (!KNOWN_ARTIFACT_KEYWORD_KEYS.includes(key)) {
      problems.push(`unknown key "${key}"`);
    }
  }
  const accept = keyword["accept"];
  const share = keyword["share"];
  if (share !== undefined && typeof share !== "boolean") {
    problems.push(`"share" must be a boolean`);
  }
  const bundle = readBundleKeyword(
    keyword["bundle"] as ArtifactJsonSchemaNode | undefined,
    problems,
  );
  return {
    accept: Array.isArray(accept)
      ? (accept as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    bundle,
    share: bundle !== null && share === true,
    problems,
  };
}

export type ArtifactNodeMatch = ReadArtifactKeyword & {
  readonly nullable: boolean;
  readonly description: string | null;
};

function readDescription(node: ArtifactJsonSchemaNode): string | null {
  const description = asRecord(node)?.["description"];
  return typeof description === "string" ? description : null;
}

/**
 * Matches a node that is an artifact field, either directly or as
 * `anyOf: [<artifact>, { type: "null" }]` (Zod's `.nullable()`).
 */
export function matchArtifactNode(
  node: ArtifactJsonSchemaNode,
): ArtifactNodeMatch | null {
  const direct = readArtifactKeyword(node);
  if (direct) {
    const types = asRecord(node)?.["type"];
    return {
      ...direct,
      nullable: Array.isArray(types) && types.includes("null"),
      description: readDescription(node),
    };
  }

  const record = asRecord(node);
  if (!record) return null;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schemaBranches(record, keyword);
    const nonNull = branches.filter((branch) => !isNullSchema(branch));
    const [only] = nonNull;
    if (!only || nonNull.length !== 1 || branches.length !== 2) continue;
    const inner = readArtifactKeyword(only);
    if (!inner) continue;
    return {
      ...inner,
      nullable: true,
      description: readDescription(node) ?? readDescription(only),
    };
  }
  return null;
}

const MAX_REF_HOPS = 16;

function resolveLocalRef(
  root: ArtifactJsonSchemaNode,
  ref: string,
): ArtifactJsonSchemaNode | null {
  if (!ref.startsWith("#")) return null;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  let current: unknown = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[token];
  }
  return typeof current === "object" && current !== null
    ? (current as ArtifactJsonSchemaNode)
    : null;
}

/**
 * Every artifact field declared in a result schema: walks object
 * properties, `anyOf` / `oneOf` / `allOf` branches, local `$ref`s and array
 * items. Fields inside arrays are returned with `inArray: true`; v1 rejects
 * them at definition time. Keyword problems (unknown keys) are dropped here;
 * use `findArtifactFieldsWithProblems` where they must stop the step.
 */
export function findArtifactFields(
  schema: ArtifactJsonSchemaNode | null | undefined,
): ArtifactField[] {
  return findArtifactFieldsWithProblems(schema).fields;
}

/** Formats a field problem as one line ending in the newer-worker hint. */
export function describeArtifactFieldProblem(
  problem: ArtifactFieldProblem,
): string {
  return `Artifact field \`${problem.path}\`: ${problem.message}; ${ARTIFACT_KEYWORD_NEWER_WORKER_HINT}.`;
}

/**
 * `findArtifactFields` plus every problem with a field's `x-scarn-artifact`
 * keyword, such as a key this SDK doesn't know. The plugin and the worker
 * refuse a step whose result schema has any (see
 * `describeArtifactFieldProblem`).
 */
export function findArtifactFieldsWithProblems(
  schema: ArtifactJsonSchemaNode | null | undefined,
): {
  readonly fields: ArtifactField[];
  readonly problems: ArtifactFieldProblem[];
} {
  if (schema === null || schema === undefined) {
    return { fields: [], problems: [] };
  }
  const root = schema;
  const fields = new Map<string, ArtifactField>();
  const problems: ArtifactFieldProblem[] = [];

  const visit = (
    node: ArtifactJsonSchemaNode,
    path: string,
    inArray: boolean,
    hops: number,
  ): void => {
    if (hops > MAX_REF_HOPS) return;
    const record = asRecord(node);
    if (!record) return;

    const ref = record["$ref"];
    if (typeof ref === "string") {
      const target = resolveLocalRef(root, ref);
      if (target) visit(target, path, inArray, hops + 1);
      return;
    }

    const match = path ? matchArtifactNode(node) : null;
    if (match) {
      if (!fields.has(path)) {
        fields.set(path, {
          path,
          accept: match.accept,
          nullable: match.nullable,
          description: match.description,
          inArray,
          bundle: match.bundle,
          share: match.share,
        });
        for (const message of match.problems) problems.push({ path, message });
      }
      return;
    }

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      for (const branch of schemaBranches(record, keyword)) {
        visit(branch, path, inArray, hops + 1);
      }
    }

    const properties = asRecord(
      record["properties"] as ArtifactJsonSchemaNode | undefined,
    );
    for (const [key, child] of Object.entries(properties ?? {})) {
      const childNode = child as ArtifactJsonSchemaNode;
      visit(childNode, path ? `${path}.${key}` : key, inArray, hops);
    }

    const items = record["items"] as ArtifactJsonSchemaNode | undefined;
    if (items !== undefined) visit(items, `${path}[]`, true, hops);
    const prefixItems = record["prefixItems"];
    if (Array.isArray(prefixItems)) {
      for (const item of prefixItems as ArtifactJsonSchemaNode[]) {
        visit(item, `${path}[]`, true, hops);
      }
    }
  };

  visit(schema, "", false, 0);
  return { fields: [...fields.values()], problems };
}
