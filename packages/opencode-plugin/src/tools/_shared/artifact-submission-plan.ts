/**
 * How `scarn-submit-artifact` turns a submitted file or folder into a
 * `SubmittedArtifact`: the checks against the declared field, the bundle
 * tree walk (limits, symlinks, entry page) and the copy into the
 * step-artifacts folder.
 */
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_BUNDLE_LIMITS,
  DEFAULT_ARTIFACT_BUNDLE_ENTRY,
  artifactAcceptsFile,
  artifactBundleEntryProblem,
  artifactFileExtension,
  type ArtifactBundleLimits,
  type ArtifactField,
} from "@scarn/sdk/contracts/artifacts";
import {
  STEP_ARTIFACTS_RELATIVE_DIR,
  type SubmittedArtifact,
} from "@scarn/sdk/contracts/step-artifact-submissions";

const MIB = 1024 * 1024;

export function formatMiB(bytes: number): string {
  return `${String(Math.round((bytes / MIB) * 10) / 10)} MiB`;
}

export function describeAccept(field: ArtifactField): string {
  if (field.bundle) return `folder with entry page ${field.bundle.entry}`;
  return field.accept.length > 0 ? field.accept.join(", ") : "any file";
}

function normalizeStoredName(name: string): string {
  const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/")
  ) {
    throw new Error(
      `\`name\` must be a file path inside ${STEP_ARTIFACTS_RELATIVE_DIR}, e.g. "screens/banner.png". Got "${name}".`,
    );
  }
  return normalized;
}

/** A bundle is stored as one folder directly under the artifacts folder. */
function normalizeBundleName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error(
      `\`name\` for a folder must be a single folder name, e.g. "report". Got "${name}".`,
    );
  }
  return trimmed;
}

type BundleFile = {
  /** Path relative to the bundle folder, with `/` separators. */
  readonly relativePath: string;
  /** Where to read it from (a symlink's target). */
  readonly absolutePath: string;
  readonly sizeBytes: number;
};

type BundleTree = {
  readonly files: BundleFile[];
  readonly sizeBytes: number;
};

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Lists every file in a bundle folder, checking the limits as it goes.
 * Symlinks to files inside the folder are followed; symlinks out of the
 * folder, and symlinked folders, are refused.
 */
async function readBundleTree(
  rootPath: string,
  limits: ArtifactBundleLimits,
): Promise<BundleTree> {
  const realRoot = await realpath(rootPath);
  const files: BundleFile[] = [];
  let sizeBytes = 0;

  const addFile = (
    relativePath: string,
    absolutePath: string,
    size: number,
  ) => {
    if (files.length + 1 > limits.maxFiles) {
      throw new Error(
        `${rootPath} holds more than ${String(limits.maxFiles)} files, the limit for a bundle.`,
      );
    }
    if (size > limits.maxFileBytes) {
      throw new Error(
        `${relativePath} in ${rootPath} is ${formatMiB(size)}; a bundle file can be at most ${formatMiB(limits.maxFileBytes)}.`,
      );
    }
    sizeBytes += size;
    if (sizeBytes > limits.maxBundleBytes) {
      throw new Error(
        `${rootPath} holds more than ${formatMiB(limits.maxBundleBytes)}, the limit for a bundle.`,
      );
    }
    files.push({ relativePath, absolutePath, sizeBytes: size });
  };

  const visit = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(path.join(realRoot, relativeDir), {
      withFileTypes: true,
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(realRoot, relativePath);
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolutePath).catch(() => null);
        if (!target || !isInside(realRoot, target)) {
          throw new Error(
            `${relativePath} in ${rootPath} is a symlink that points outside the folder. A bundle must be self-contained; copy the file in instead.`,
          );
        }
        const targetStats = await stat(target);
        if (!targetStats.isFile()) {
          throw new Error(
            `${relativePath} in ${rootPath} is a symlink to a folder. Bundles can only hold symlinks to files.`,
          );
        }
        addFile(relativePath, target, targetStats.size);
        continue;
      }
      if (entry.isFile()) {
        addFile(relativePath, absolutePath, (await lstat(absolutePath)).size);
        continue;
      }
      throw new Error(
        `${relativePath} in ${rootPath} is not a regular file or folder.`,
      );
    }
  };

  await visit("");
  if (files.length === 0) throw new Error(`Folder is empty: ${rootPath}`);
  return { files, sizeBytes };
}

/** Whether two stored paths would write over each other. */
export function storedPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export type SubmissionPlan = {
  readonly field: ArtifactField | null;
  readonly stored: string;
  readonly entry: SubmittedArtifact;
  readonly copy: (destination: string) => Promise<void>;
};

function checkFileAgainstField(
  field: ArtifactField | null,
  sourcePath: string,
): void {
  if (field?.bundle) {
    throw new Error(
      `\`${field.path}\` is a bundle field and needs a folder with entry page ${field.bundle.entry}, but ${path.basename(sourcePath)} is a file. Submit the folder instead.`,
    );
  }
  if (field && !artifactAcceptsFile(field.accept, sourcePath)) {
    const extension = artifactFileExtension(sourcePath) || "no extension";
    throw new Error(
      `\`${field.path}\` accepts ${describeAccept(field)}, but ${path.basename(sourcePath)} has ${extension}.${
        field.description ? ` ${field.path}: ${field.description}` : ""
      }`,
    );
  }
}

export function planFile(input: {
  field: ArtifactField | null;
  name: string | null;
  entryName: string | null;
  sourcePath: string;
  submittedPath: string;
  size: number;
}): SubmissionPlan {
  const { field, sourcePath } = input;
  checkFileAgainstField(field, sourcePath);
  if (input.entryName) {
    throw new Error("`entry` is only for folders; a file has no entry page.");
  }
  if (input.size === 0) throw new Error(`File is empty: ${sourcePath}`);
  const stored = field
    ? `${field.path}${artifactFileExtension(sourcePath)}`
    : normalizeStoredName(input.name ?? path.basename(sourcePath));
  return {
    field,
    stored,
    entry: {
      kind: "file",
      stored,
      sourcePath: input.submittedPath,
      sizeBytes: input.size,
    },
    copy: async (destination) => {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
    },
  };
}

export async function planBundle(input: {
  field: ArtifactField | null;
  name: string | null;
  entryName: string | null;
  sourcePath: string;
  submittedPath: string;
}): Promise<SubmissionPlan> {
  const { field, sourcePath } = input;
  if (field && !field.bundle) {
    throw new Error(
      `\`${field.path}\` is a file field and accepts ${describeAccept(field)}, but ${path.basename(sourcePath)} is a folder. Submit a single file instead.`,
    );
  }
  if (field && input.entryName) {
    throw new Error(
      `\`entry\` comes from the field: \`${field.path}\` opens ${field.bundle?.entry ?? DEFAULT_ARTIFACT_BUNDLE_ENTRY}. Don't pass \`entry\` with \`field\`.`,
    );
  }
  const entry =
    field?.bundle?.entry ?? input.entryName ?? DEFAULT_ARTIFACT_BUNDLE_ENTRY;
  const entryProblem = artifactBundleEntryProblem(entry);
  if (entryProblem) throw new Error(`\`entry\` is invalid: ${entryProblem}.`);
  const stored = field
    ? field.path
    : normalizeBundleName(input.name ?? path.basename(sourcePath));

  const tree = await readBundleTree(sourcePath, ARTIFACT_BUNDLE_LIMITS);
  if (!tree.files.some((file) => file.relativePath === entry)) {
    throw new Error(
      `${sourcePath} has no entry page ${entry}.${
        field ? "" : " Pass `entry` if the page has another name."
      }`,
    );
  }

  return {
    field,
    stored,
    entry: {
      kind: "bundle",
      stored,
      sourcePath: input.submittedPath,
      sizeBytes: tree.sizeBytes,
      entry,
      fileCount: tree.files.length,
    },
    copy: async (destination) => {
      for (const file of tree.files) {
        const target = path.join(destination, ...file.relativePath.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(file.absolutePath, target);
      }
    },
  };
}

/** Same path, or one inside the other, once symlinks are resolved. */
export async function relateSourceToDestination(
  sourcePath: string,
  destination: string,
): Promise<"same" | "nested" | "apart"> {
  const realSource = await realpath(sourcePath);
  const realDestination = await realpath(destination).catch(() =>
    path.resolve(destination),
  );
  if (realSource === realDestination) return "same";
  if (
    isInside(realSource, realDestination) ||
    isInside(realDestination, realSource)
  ) {
    return "nested";
  }
  return "apart";
}
