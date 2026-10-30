import { rm, mkdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

// SCARN_CLI_LINK_NAME lets callers (e.g. scripts/cli-link-dev.sh) link under
// an alternate bin name such as "scarn-dev", so a dev build doesn't clobber
// a real "scarn" install on the same machine. Defaults to "scarn" for the
// plain `cli:link` production flow.
const linkName = process.env["SCARN_CLI_LINK_NAME"] ?? "scarn";
const pkgDirName =
  linkName === "scarn"
    ? "cli"
    : `cli-${linkName.replace(/^scarn-/u, "")}`;

const npmPrefix = execFileSync("npm", ["prefix", "-g"], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
}).trim();

const scopeDir = join(npmPrefix, "lib", "node_modules", "@scarn");
const pkgLink = join(scopeDir, pkgDirName);
const binDir = join(npmPrefix, "bin");
const binLink = join(binDir, linkName);

await mkdir(scopeDir, { recursive: true });

await rm(pkgLink, { force: true, recursive: true });
await symlink(projectRoot, pkgLink);

await rm(binLink, { force: true });
// Match npm's relative symlink style: bin/<linkName> -> ../lib/node_modules/@scarn/<pkgDirName>/bin/scarn
await symlink(relative(binDir, join(pkgLink, "bin", "scarn")), binLink);

process.stdout.write(`Linked: ${binLink}\n`);
