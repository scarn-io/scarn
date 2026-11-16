import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { devcontainerExists } from "../../../../src/work/task-run/infra/resolve-launch-environment";
import { rejectionOf } from "./helpers/orchestrator-launch-fakes";

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), "devcontainer-exists-"));
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

test("only ENOENT means an absent config; directories remain present", async () => {
  expect(await devcontainerExists(workspacePath, "missing.json")).toBe(false);
  await mkdir(path.join(workspacePath, "directory.json"));
  expect(await devcontainerExists(workspacePath, "directory.json")).toBe(true);
  await writeFile(path.join(workspacePath, "not-directory"), "");
  const error = await rejectionOf(
    devcontainerExists(workspacePath, "not-directory/devcontainer.json"),
  );
  expect((error as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  await symlink("loop", path.join(workspacePath, "loop"));
  const loopError = await rejectionOf(
    devcontainerExists(workspacePath, "loop/devcontainer.json"),
  );
  expect((loopError as NodeJS.ErrnoException).code).toBe("ELOOP");
});
