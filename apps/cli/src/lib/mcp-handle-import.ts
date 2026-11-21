import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectPipelineRuntime } from "@scarn/worker";
import {
  MCP_HANDLES_OUTPUT_MARKER,
  MCP_HANDLES_SCRIPT_FILENAME,
  MCP_HANDLES_SCRIPT_TEMPLATE,
} from "../templates/mcp-handles-script";
import type { ImportedMcpHandles } from "./mcp-pull";

/**
 * Imports `defineMcp` handles from the pipeline-builder directory in a real
 * bun/tsx/deno subprocess, as `scarn pipelines studio` collects definitions:
 * the compiled `scarn` binary cannot resolve `@scarn/sdk` for external files.
 * The script only reports each handle's connection fields as written (still
 * `{env:VAR}` placeholders), so no value is ever resolved here.
 */
export async function importMcpHandlesViaSubprocess(input: {
  builderDir: string;
  request?: { file: string; exportName?: string | undefined } | undefined;
}): Promise<ImportedMcpHandles> {
  const detected = detectPipelineRuntime(input.builderDir);
  if (!detected.ok) throw new Error(detected.message);
  const { runtime } = detected;

  const scriptPath = join(input.builderDir, MCP_HANDLES_SCRIPT_FILENAME);
  writeFileSync(scriptPath, MCP_HANDLES_SCRIPT_TEMPLATE, "utf8");
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    if (input.request === undefined) {
      delete env["SCARN_MCP_HANDLE_REQUEST"];
    } else {
      env["SCARN_MCP_HANDLE_REQUEST"] = JSON.stringify(input.request);
    }
    const subprocess = Bun.spawn(
      [runtime.command, ...runtime.args, MCP_HANDLES_SCRIPT_FILENAME],
      { cwd: input.builderDir, stdout: "pipe", stderr: "pipe", env },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    const line = stdout
      .split("\n")
      .reverse()
      .find((candidate) => candidate.startsWith(MCP_HANDLES_OUTPUT_MARKER));
    if (line === undefined) {
      throw new Error(
        `Could not read the MCP handles in ${input.builderDir} with ${runtime.kind} (exit code ${String(exitCode)}).`,
      );
    }
    const result = JSON.parse(line.slice(MCP_HANDLES_OUTPUT_MARKER.length)) as
      ({ ok: true } & ImportedMcpHandles) | { ok: false; message: string };
    if (!result.ok) throw new Error(result.message);
    return { handles: result.handles, errors: result.errors };
  } finally {
    rmSync(scriptPath, { force: true });
  }
}
