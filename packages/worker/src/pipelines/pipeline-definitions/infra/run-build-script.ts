// Runs `build-script.ts.tmpl` on the user's native runtime (bun, tsx or
// deno), the same way `scarn pipelines push` runs its push script: a
// compiled `scarn` binary can't resolve `@scarn/sdk`'s exports-map
// subpaths from the user's own files, so the import happens in a real
// subprocess inside the pipeline-builder directory.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildScriptResult } from "../domain/pipeline-build";
import { detectPipelineRuntime } from "./detect-pipeline-runtime";
import {
  BUILD_SCRIPT_FILENAME,
  BUILD_SCRIPT_MARKER,
  BUILD_SCRIPT_TEMPLATE,
} from "./build-script";

/** Thrown when the build script itself couldn't run or report. */
export class BuildScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildScriptError";
  }
}

function parseResults(
  stdout: string,
  stderr: string,
  exitCode: number,
): BuildScriptResult[] {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(BUILD_SCRIPT_MARKER));
  if (line === undefined) {
    throw new BuildScriptError(
      `The pipeline build script exited with code ${String(exitCode)} without reporting a result.\n` +
        (stderr.trim() || stdout.trim() || "(no output)"),
    );
  }
  return JSON.parse(
    line.slice(BUILD_SCRIPT_MARKER.length),
  ) as BuildScriptResult[];
}

/**
 * Imports each of `files` (absolute paths) in `builderDir` and returns what
 * each default export compiled to. A file that fails to import comes back as
 * an `ok: false` result; only a failure of the script itself throws.
 */
export async function runBuildScript(
  builderDir: string,
  files: readonly string[],
): Promise<BuildScriptResult[]> {
  if (files.length === 0) return [];
  const detected = detectPipelineRuntime(builderDir);
  if (!detected.ok) {
    throw new BuildScriptError(detected.message);
  }
  const { runtime } = detected;
  const scriptPath = join(builderDir, BUILD_SCRIPT_FILENAME);
  writeFileSync(scriptPath, BUILD_SCRIPT_TEMPLATE, "utf8");
  try {
    const subprocess = Bun.spawn(
      [runtime.command, ...runtime.args, BUILD_SCRIPT_FILENAME, ...files],
      { cwd: builderDir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    return parseResults(stdout, stderr, exitCode);
  } catch (error) {
    if (error instanceof BuildScriptError) throw error;
    throw new BuildScriptError(
      `Could not run ${runtime.command}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(scriptPath, { force: true });
  }
}
