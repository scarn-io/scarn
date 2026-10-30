/**
 * Unit test for the bundled-skill seeding in
 * {@link DevcontainerOpencodeBootstrap.prepareAgentHome}. A fake `docker` on
 * `PATH` records every invocation and its stdin, so the test checks what would
 * be written inside the container without running one.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BUNDLED_SKILL_FILES } from "@scarn/opencode-plugin";
import {
  CONTAINER_AGENT_HOME,
  DevcontainerOpencodeBootstrap,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";

type DockerCall = { args: string[]; stdin: string };

describe("DevcontainerOpencodeBootstrap.prepareAgentHome bundled skills", () => {
  let tempDir: string;
  let callsPath: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "devcontainer-skills-"));
    callsPath = path.join(tempDir, "calls.jsonl");
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    const recorder = path.join(tempDir, "record.ts");
    await writeFile(
      recorder,
      [
        `import { appendFileSync } from "node:fs";`,
        `const stdin = process.argv.includes("-i") ? await Bun.stdin.text() : "";`,
        `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");`,
      ].join("\n"),
    );
    const docker = path.join(binDir, "docker");
    await writeFile(
      docker,
      `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
    );
    await chmod(docker, 0o755);
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.env["PATH"] = originalPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readCalls(): Promise<DockerCall[]> {
    const raw = await readFile(callsPath, "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DockerCall);
  }

  test("writes every bundled skill file under the agent HOME's .claude/skills", async () => {
    await new DevcontainerOpencodeBootstrap().prepareAgentHome({
      containerId: "container-1",
      hostHomeDir: path.join(tempDir, "empty-home"),
    });

    const calls = await readCalls();
    for (const file of BUNDLED_SKILL_FILES) {
      const target = `${CONTAINER_AGENT_HOME}/.claude/skills/${file.relativePath}`;
      const write = calls.find((call) =>
        call.args.at(-1)?.includes(`cat > '${target}'`),
      );
      expect(write?.args.slice(0, 3)).toEqual(["exec", "-i", "container-1"]);
      expect(write?.stdin).toBe(file.content);
    }
  });

  test("never writes skills into the workspace", async () => {
    await new DevcontainerOpencodeBootstrap().prepareAgentHome({
      containerId: "container-1",
      hostHomeDir: path.join(tempDir, "empty-home"),
    });

    const commands = (await readCalls()).map((call) => call.args.at(-1) ?? "");
    for (const command of commands) {
      expect(command).not.toContain("/workspaces/");
      expect(command).not.toMatch(/(^|[\s'])\.(claude|agents|opencode)\//u);
    }
  });
});
