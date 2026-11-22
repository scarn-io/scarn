/**
 * Rebuilds the sandbox repos under `ROOT_DIR` from scratch on every seed:
 *
 * - `template-mirror.git`: a cached bare mirror of `TEMPLATE_REF` from the
 *   template repo, so reseeding only fetches what changed.
 * - `acme-shop.git`: the project's `gitUrl`, recreated holding only
 *   `TEMPLATE_REF`, which drops the worker's old `scarn/*` branches.
 * - `acme-shop`: the checkout `scarn work` runs in (origin = the bare repo,
 *   upstream = the template). It gets `src/local-test-project/.scarn/`, the
 *   project ref and a vendored SDK tarball. Seed builds the pipelines there,
 *   then `commitAndPush` publishes it so the worker's clone of the bare repo
 *   sees the same pipeline-builder.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { MONOREPO_ROOT, PACKAGE_ROOT } from "./config";

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
]);
const MIRROR_EXCLUDED = new Set([
  ...LOCKFILES,
  "node_modules",
  "vendor",
  "push.ts",
  "scarn.jsonc",
]);

const SDK_DIR = path.join(MONOREPO_ROOT, "packages", "sdks", "js");
const VENDORED_SDK_RELATIVE = "vendor/scarn-sdk.tgz";
const COMMIT_AUTHOR = "scarn local-dev";
const COMMIT_EMAIL = "local-dev@scarn.local";

export const LOCAL_TEST_PROJECT_DIR = path.join(
  PACKAGE_ROOT,
  "src",
  "local-test-project",
);

export interface RepoPaths {
  rootDir: string;
  mirror: string;
  bare: string;
  checkout: string;
}

export function repoPaths(rootDir: string): RepoPaths {
  return {
    rootDir,
    mirror: path.join(rootDir, "template-mirror.git"),
    bare: path.join(rootDir, "acme-shop.git"),
    checkout: path.join(rootDir, "acme-shop"),
  };
}

async function run(
  command: string[],
  cwd: string,
  options: { inheritStderr?: boolean } = {},
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: options.inheritStderr ? "inherit" : "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.stderr instanceof ReadableStream
      ? new Response(child.stderr).text()
      : Promise.resolve(""),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[local-dev] \`${command.join(" ")}\` exited with ${String(exitCode)} (cwd: ${cwd})\n${stderr || stdout}`,
    );
  }
  return stdout;
}

function git(args: string[], cwd: string): Promise<string> {
  return run(["git", ...args], cwd);
}

async function syncTemplateMirror(
  paths: RepoPaths,
  templateUrl: string,
  templateRef: string,
): Promise<void> {
  if (!existsSync(path.join(paths.mirror, "HEAD"))) {
    await rm(paths.mirror, { recursive: true, force: true });
    await git(["init", "--quiet", "--bare", paths.mirror], paths.rootDir);
  }
  await git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--force",
      templateUrl,
      `refs/heads/${templateRef}:refs/heads/${templateRef}`,
    ],
    paths.mirror,
  );
}

async function recreateBareRepo(
  paths: RepoPaths,
  templateRef: string,
): Promise<void> {
  await rm(paths.bare, { recursive: true, force: true });
  await git(
    [
      "init",
      "--quiet",
      "--bare",
      `--initial-branch=${templateRef}`,
      paths.bare,
    ],
    paths.rootDir,
  );
  await git(
    [
      "push",
      "--quiet",
      paths.bare,
      `refs/heads/${templateRef}:refs/heads/${templateRef}`,
    ],
    paths.mirror,
  );
}

async function recreateCheckout(
  paths: RepoPaths,
  templateUrl: string,
  templateRef: string,
): Promise<void> {
  await rm(paths.checkout, { recursive: true, force: true });
  await git(
    ["clone", "--quiet", "--branch", templateRef, paths.bare, paths.checkout],
    paths.rootDir,
  );
  await git(["remote", "add", "upstream", templateUrl], paths.checkout);
}

async function mirrorScarnDir(checkout: string): Promise<void> {
  const source = path.join(LOCAL_TEST_PROJECT_DIR, ".scarn");
  const target = path.join(checkout, ".scarn");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    filter: (entry) => !MIRROR_EXCLUDED.has(path.basename(entry)),
  });
}

async function writeProjectConfig(dir: string, ref: string): Promise<void> {
  const scarnDir = path.join(dir, ".scarn");
  await mkdir(scarnDir, { recursive: true });
  await writeFile(
    path.join(scarnDir, "scarn.jsonc"),
    `${JSON.stringify({ project: ref }, null, 2)}\n`,
  );
}

async function packLocalSdk(): Promise<string> {
  const stdout = await run(["bun", "run", "pack:local"], SDK_DIR, {
    inheritStderr: true,
  });
  const artifact = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
  if (!artifact.endsWith(".tgz") || !existsSync(artifact)) {
    throw new Error(
      `[local-dev] \`bun run pack:local\` did not print a .tgz path, got: ${artifact}`,
    );
  }
  return artifact;
}

async function vendorSdk(builderDir: string): Promise<void> {
  const artifact = await packLocalSdk();
  const vendored = path.join(builderDir, VENDORED_SDK_RELATIVE);
  await mkdir(path.dirname(vendored), { recursive: true });
  await cp(artifact, vendored);

  const manifestPath = path.join(builderDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  manifest.dependencies = {
    ...manifest.dependencies,
    "@scarn/sdk": `file:./${VENDORED_SDK_RELATIVE}`,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await run(["bun", "install"], builderDir, { inheritStderr: true });
}

async function assertCommittable(checkout: string): Promise<void> {
  const vendored = path.posix.join(
    ".scarn",
    "pipeline-builder",
    VENDORED_SDK_RELATIVE,
  );
  const staged = (await git(["ls-files", "--cached"], checkout))
    .split("\n")
    .filter(Boolean);
  if (!staged.includes(vendored)) {
    throw new Error(
      `[local-dev] ${vendored} is not staged in ${checkout}; check the checkout's .gitignore files`,
    );
  }
  const leaked = staged.filter((file) => {
    if (!file.startsWith(".scarn/")) return false;
    const segments = file.split("/");
    return (
      segments.includes("node_modules") || LOCKFILES.has(segments.at(-1) ?? "")
    );
  });
  if (leaked.length > 0) {
    throw new Error(
      `[local-dev] refusing to commit generated files: ${leaked.join(", ")}`,
    );
  }
}

export async function commitAndPush(
  checkout: string,
  templateRef: string,
): Promise<void> {
  await git(["add", "--all"], checkout);
  await assertCommittable(checkout);
  await git(
    [
      "-c",
      `user.name=${COMMIT_AUTHOR}`,
      "-c",
      `user.email=${COMMIT_EMAIL}`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "--allow-empty",
      "-m",
      "chore: seed local-dev pipeline-builder",
    ],
    checkout,
  );
  await git(["push", "--quiet", "origin", templateRef], checkout);
}

export async function rebuildRepos(input: {
  rootDir: string;
  templateUrl: string;
  templateRef: string;
  projectRef: string;
}): Promise<RepoPaths> {
  const { rootDir, templateUrl, templateRef, projectRef } = input;
  const paths = repoPaths(rootDir);
  await mkdir(rootDir, { recursive: true });

  await syncTemplateMirror(paths, templateUrl, templateRef);
  await recreateBareRepo(paths, templateRef);
  await recreateCheckout(paths, templateUrl, templateRef);

  await mirrorScarnDir(paths.checkout);
  await writeProjectConfig(paths.checkout, projectRef);
  await writeProjectConfig(LOCAL_TEST_PROJECT_DIR, projectRef);

  await vendorSdk(path.join(paths.checkout, ".scarn", "pipeline-builder"));
  return paths;
}
