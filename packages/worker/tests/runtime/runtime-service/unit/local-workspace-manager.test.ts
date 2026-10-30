/**
 * The host workspace layout: each session's clone lives at
 * `<root>/<sessionId>/repo`, removal takes the whole session directory, and
 * nothing outside the root (or another session's directory) is touched.
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalWorkspaceManager } from "../../../../src/runtime/runtime-service/infra/local-workspace-manager";

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the promise to reject");
}

describe("LocalWorkspaceManager", () => {
  let sandbox: string;
  let root: string;
  let outsideFile: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "workspace-manager-"));
    root = path.join(sandbox, "sessions");
    await mkdir(root);
    outsideFile = path.join(sandbox, "outside.txt");
    await writeFile(outsideFile, "keep me");
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  describe("createWorkspace", () => {
    test("creates the clone directory at <root>/<sessionId>/repo", async () => {
      const manager = new LocalWorkspaceManager(root);

      const { workspacePath } = await manager.createWorkspace({
        sessionId: "session-a",
      });

      expect(workspacePath).toBe(path.join(root, "session-a", "repo"));
      expect(await readdir(workspacePath)).toEqual([]);
      expect(await readdir(path.join(root, "session-a"))).toEqual(["repo"]);
    });

    test("gives every session the same basename, repo", async () => {
      const manager = new LocalWorkspaceManager(root);

      const a = await manager.createWorkspace({ sessionId: "session-a" });
      const b = await manager.createWorkspace({ sessionId: "session-b" });

      expect(path.basename(a.workspacePath)).toBe("repo");
      expect(path.basename(b.workspacePath)).toBe("repo");
      expect(a.workspacePath).not.toBe(b.workspacePath);
    });

    test("clears leftovers from an earlier workspace for the same session", async () => {
      const manager = new LocalWorkspaceManager(root);
      await mkdir(path.join(root, "session-a", "repo"), { recursive: true });
      await writeFile(path.join(root, "session-a", "repo", "stale.txt"), "x");
      await writeFile(path.join(root, "session-a", "stray.txt"), "x");

      const { workspacePath } = await manager.createWorkspace({
        sessionId: "session-a",
      });

      expect(await readdir(workspacePath)).toEqual([]);
      expect(await readdir(path.join(root, "session-a"))).toEqual(["repo"]);
    });

    test("leaves other sessions and files outside the root alone", async () => {
      const manager = new LocalWorkspaceManager(root);
      const other = await manager.createWorkspace({ sessionId: "session-b" });
      await writeFile(path.join(other.workspacePath, "file.txt"), "x");

      await manager.createWorkspace({ sessionId: "session-a" });

      expect(await readdir(other.workspacePath)).toEqual(["file.txt"]);
      expect(await pathExists(outsideFile)).toBe(true);
    });

    test("refuses a session id that escapes the root", async () => {
      const manager = new LocalWorkspaceManager(root);

      const error = await rejectionOf(
        manager.createWorkspace({ sessionId: "../escape" }),
      );

      expect(error.message).toContain("Refusing to manage workspace outside");
      expect((await readdir(sandbox)).sort()).toEqual([
        "outside.txt",
        "sessions",
      ]);
    });
  });

  describe("removeWorkspace", () => {
    test("removes the whole session directory, not just repo", async () => {
      const manager = new LocalWorkspaceManager(root);
      const { workspacePath } = await manager.createWorkspace({
        sessionId: "session-a",
      });
      await writeFile(path.join(workspacePath, "file.txt"), "x");

      await manager.removeWorkspace(workspacePath);

      expect(await readdir(root)).toEqual([]);
    });

    test("leaves other sessions and files outside the root alone", async () => {
      const manager = new LocalWorkspaceManager(root);
      const a = await manager.createWorkspace({ sessionId: "session-a" });
      const b = await manager.createWorkspace({ sessionId: "session-b" });
      await writeFile(path.join(b.workspacePath, "file.txt"), "x");

      await manager.removeWorkspace(a.workspacePath);

      expect(await readdir(root)).toEqual(["session-b"]);
      expect(await readdir(b.workspacePath)).toEqual(["file.txt"]);
      expect(await pathExists(outsideFile)).toBe(true);
    });

    test("is a no-op for a session directory that is already gone", async () => {
      const manager = new LocalWorkspaceManager(root);

      await manager.removeWorkspace(path.join(root, "session-a", "repo"));

      expect(await readdir(root)).toEqual([]);
    });

    test.each([
      [
        "a path outside the root",
        () => path.join(sandbox, "elsewhere", "repo"),
      ],
      ["the session directory itself", () => path.join(root, "session-a")],
      [
        "a path nested deeper than the clone",
        () => path.join(root, "session-a", "repo", "repo"),
      ],
      ["the root's own repo folder", () => path.join(root, "repo")],
    ])("refuses %s and deletes nothing", async (_label, target) => {
      const manager = new LocalWorkspaceManager(root);
      const { workspacePath } = await manager.createWorkspace({
        sessionId: "session-a",
      });
      await mkdir(path.join(sandbox, "elsewhere", "repo"), { recursive: true });

      const error = await rejectionOf(manager.removeWorkspace(target()));

      expect(error.message).toContain("Refusing to manage workspace outside");
      expect(await readdir(workspacePath)).toEqual([]);
      expect(await readdir(path.join(sandbox, "elsewhere"))).toEqual(["repo"]);
      expect(await pathExists(outsideFile)).toBe(true);
    });
  });
});
