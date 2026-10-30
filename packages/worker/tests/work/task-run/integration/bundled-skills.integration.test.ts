/**
 * Integration test for the bundled skills against a real OpenCode 2.1.4
 * process: {@link HostOpencodeBootstrap} seeds them into the agent HOME, the
 * server lists them, and a repo skill with the same id wins.
 *
 * Gated behind SCARN_INTEGRATION=true (it provisions the real runtime
 * payload). Run with:
 *   SCARN_INTEGRATION=true bun test tests/work/task-run/integration/bundled-skills.integration.test.ts
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildOpencodeContext } from "@scarn/opencode-plugin";
import { HostOpencodeBootstrap } from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { basicAuthHeader } from "../../../../src/runtime/runtime-service/infra/opencode-server-contract";

const integrationEnabled = process.env["SCARN_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;

type SkillInfo = { id: string; description?: string; path?: string };

describe.skipIf(!integrationEnabled)("bundled skills (integration)", () => {
  let tempDir: string;
  let pid: number | null = null;
  const bootstrap = new HostOpencodeBootstrap();

  beforeEach(async () => {
    tempDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "bundled-skills-int-")),
    );
  });

  afterEach(async () => {
    bootstrap.stop(pid);
    pid = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  test(
    "lists the bundled skills, and a repo skill wins on a name clash",
    async () => {
      const workspaceFolder = path.join(tempDir, "repo");
      const repoSkillDir = path.join(
        workspaceFolder,
        ".agents/skills/grilling",
      );
      await mkdir(path.join(workspaceFolder, ".git"), { recursive: true });
      await mkdir(repoSkillDir, { recursive: true });
      await writeFile(
        path.join(repoSkillDir, "SKILL.md"),
        "---\nname: grilling\ndescription: The repo's own grilling\n---\nRepo body\n",
      );

      const payload = await new OpencodeRuntimePayloadProvisioner().ensure();
      const { opencodeConfigContent } = await buildOpencodeContext({
        workspacePath: workspaceFolder,
        stepMcpServers: null,
      });
      const started = await bootstrap.start({
        hostLaunchWrapperPath: path.join(payload.hostPayloadDir, "launch.sh"),
        expectedVersion: payload.version,
        workspaceFolder,
        sessionAgentHomeDir: path.join(tempDir, "agent-home"),
        credentials: [],
        providerEnv: {},
        opencodeConfigContent,
      });
      pid = started.pid;

      const skills = await listSkillsWhenLoaded(
        started.agentBaseUrl,
        started.serverPassword,
      );
      const byId = new Map(skills.map((skill) => [skill.id, skill]));

      expect(byId.get("grilling")?.description).toBe("The repo's own grilling");
      expect(byId.get("domain-modeling")?.path).toBe(
        path.join(
          tempDir,
          "agent-home",
          ".claude/skills/domain-modeling/SKILL.md",
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );
});

/** Skill discovery finishes shortly after `/api/info` is ready; poll for it. */
async function listSkillsWhenLoaded(
  baseUrl: string,
  password: string,
): Promise<SkillInfo[]> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/skill`, {
      headers: { authorization: basicAuthHeader(password) },
    });
    const body = (await response.json()) as { data?: SkillInfo[] };
    const skills = body.data ?? [];
    if (skills.some((skill) => skill.id === "domain-modeling")) {
      return skills;
    }
    await Bun.sleep(500);
  }
  throw new Error("OpenCode never listed the bundled skills");
}
