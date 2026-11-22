/**
 * Content hash of everything that feeds the e2e `next build`: apps/next and the
 * workspace packages it (transitively) bundles from source, root build config,
 * `.env` files Next or Bun may load, and the build env. Lets the e2e runner
 * skip rebuilding when nothing relevant changed since the last successful
 * build. Paths come from `git ls-files`, so ignored output (`.next/`,
 * `node_modules/`, `dist/`) is excluded and untracked new files are included.
 * `next-env.d.ts` is excluded because `next build` itself rewrites it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const excludedPathPattern =
  /(^|\/)(tests?|__tests__)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/u;
const rootInputFiles = ["bun.lock", "package.json", "tsconfig.base.json"];
const envFileNames = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];

type WorkspacePackage = {
  dir: string;
  dependencies: string[];
};

const readWorkspacePackages = (
  repoRoot: string,
): Map<string, WorkspacePackage> => {
  const rootManifest = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const packages = new Map<string, WorkspacePackage>();

  for (const pattern of rootManifest.workspaces ?? []) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const manifestPath of glob.scanSync({ cwd: repoRoot })) {
      const manifest = JSON.parse(
        readFileSync(resolve(repoRoot, manifestPath), "utf8"),
      ) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      if (!manifest.name) {
        continue;
      }
      packages.set(manifest.name, {
        dir: dirname(manifestPath),
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
        }),
      });
    }
  }

  return packages;
};

const collectInputDirs = (repoRoot: string, appDir: string): string[] => {
  const packages = readWorkspacePackages(repoRoot);
  const appPackage = [...packages.values()].find((pkg) => pkg.dir === appDir);
  if (!appPackage) {
    throw new Error(`[e2e] ${appDir} is not a workspace package`);
  }

  const dirs = new Set<string>([appDir]);
  const pending = [...appPackage.dependencies];
  for (let name = pending.pop(); name; name = pending.pop()) {
    const pkg = packages.get(name);
    if (!pkg || dirs.has(pkg.dir)) {
      continue;
    }
    dirs.add(pkg.dir);
    pending.push(...pkg.dependencies);
  }

  return [...dirs].sort();
};

const listInputFiles = (
  repoRoot: string,
  appDir: string,
  dirs: string[],
): string[] => {
  const proc = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, stdout: "pipe", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    throw new Error("[e2e] git ls-files failed");
  }

  const prefixes = dirs.map((dir) => `${dir}/`);
  const buildGeneratedFiles = new Set([`${appDir}/next-env.d.ts`]);
  const files = new Set(rootInputFiles);
  for (const path of proc.stdout.toString().split("\0")) {
    if (
      path &&
      prefixes.some((prefix) => path.startsWith(prefix)) &&
      !excludedPathPattern.test(path) &&
      !buildGeneratedFiles.has(path)
    ) {
      files.add(path);
    }
  }
  for (const name of envFileNames) {
    files.add(name);
    files.add(`${appDir}/${name}`);
  }

  return [...files].sort();
};

export const computeBuildInputHash = (options: {
  repoRoot: string;
  appRoot: string;
  buildEnv: Record<string, string>;
}): string => {
  const { repoRoot, appRoot, buildEnv } = options;
  const hasher = new Bun.CryptoHasher("sha256");

  const env = { ...buildEnv };
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("NEXT_PUBLIC_") &&
      !(key in env) &&
      value !== undefined
    ) {
      env[key] = value;
    }
  }
  for (const key of Object.keys(env).sort()) {
    hasher.update(`env:${key}=${env[key] ?? ""}\0`);
  }

  const appDir = relative(repoRoot, appRoot);
  for (const path of listInputFiles(
    repoRoot,
    appDir,
    collectInputDirs(repoRoot, appDir),
  )) {
    const absolutePath = resolve(repoRoot, path);
    hasher.update(`file:${path}\0`);
    if (existsSync(absolutePath)) {
      hasher.update(readFileSync(absolutePath));
    }
    hasher.update("\0");
  }

  return hasher.digest("hex");
};
