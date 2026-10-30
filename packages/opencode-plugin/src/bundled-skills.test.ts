import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildOpencodeContext } from "./build-opencode-context";
import { BUNDLED_SKILL_FILES, BUNDLED_SKILLS_HOME_DIR } from "./bundled-skills";

const SKILLS_ROOT = path.join(import.meta.dirname, "..", "skills");

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : Promise.resolve([`${prefix}${entry.name}`]),
    ),
  );
  return nested.flat();
}

describe("bundled skills", () => {
  test("embed every file under skills/ verbatim", async () => {
    const onDisk = await listFiles(SKILLS_ROOT);
    expect(BUNDLED_SKILL_FILES.map((file) => file.relativePath).sort()).toEqual(
      onDisk.sort(),
    );
    for (const file of BUNDLED_SKILL_FILES) {
      expect(file.content).toBe(
        await readFile(path.join(SKILLS_ROOT, file.relativePath), "utf8"),
      );
    }
  });

  test("ship grilling and domain-modeling, each named after its directory", () => {
    const skillFiles = BUNDLED_SKILL_FILES.filter((file) =>
      file.relativePath.endsWith("/SKILL.md"),
    );
    expect(skillFiles.map((file) => file.relativePath.split("/")[0])).toEqual([
      "grilling",
      "domain-modeling",
    ]);
    for (const file of skillFiles) {
      const id = file.relativePath.split("/")[0];
      expect(file.content).toMatch(
        new RegExp(`^---\\nname: ${id ?? ""}\\ndescription: .+\\n`, "u"),
      );
    }
  });

  test("seed into a global compatibility directory, below every repo source", () => {
    expect(BUNDLED_SKILLS_HOME_DIR).toBe(".claude/skills");
  });

  test("the built config adds no skills source, so repo skills keep precedence", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "bundled-skills-test-"),
    );

    const { opencodeConfigContent } = await buildOpencodeContext({
      workspacePath,
      stepMcpServers: null,
      agentPromptText: "Grill the person.",
    });

    const config = JSON.parse(opencodeConfigContent) as Record<string, unknown>;
    expect(config).not.toHaveProperty("skills");
  });

  test("building the context writes no skills into the workspace", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "bundled-skills-test-"),
    );

    await buildOpencodeContext({ workspacePath, stepMcpServers: null });

    for (const dir of [".opencode/skills", ".claude", ".agents"]) {
      const exists = await access(path.join(workspacePath, dir))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });
});
