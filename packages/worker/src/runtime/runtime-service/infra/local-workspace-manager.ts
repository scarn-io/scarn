import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceManager } from "../application/workspace-manager";
import {
  chmodRecursiveWithDocker,
  isPermissionError,
} from "./docker-chmod-fallback";

const DEFAULT_ROOT_DIR = path.join(
  os.tmpdir(),
  "scarn-project-runtime-sessions",
);

/**
 * The clone's folder name inside each session directory. Every workspace is
 * `<root>/<sessionId>/repo`, so the devcontainer mounts it at the same
 * `/workspaces/repo` for every Task and a restored agent session's paths stay
 * valid.
 */
const WORKSPACE_DIR_NAME = "repo";

async function removeWorkspaceWithHostFs(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

async function removeWorkspaceWithDocker(workspacePath: string): Promise<void> {
  await chmodRecursiveWithDocker(workspacePath);
}

async function removeWorkspacePath(workspacePath: string): Promise<void> {
  try {
    await removeWorkspaceWithHostFs(workspacePath);
  } catch (error) {
    if (!isPermissionError(error instanceof Error ? error : undefined)) {
      throw error;
    }

    await removeWorkspaceWithDocker(workspacePath);
    await removeWorkspaceWithHostFs(workspacePath);
  }
}

/**
 * Host-side workspaces for project runtime sessions: one session directory per
 * session under the root, holding the clone at `<sessionId>/repo`.
 */
export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly rootDir: string;

  constructor(rootDir = DEFAULT_ROOT_DIR) {
    this.rootDir = path.resolve(rootDir);
  }

  async createWorkspace(input: {
    sessionId: string;
  }): Promise<{ workspacePath: string }> {
    const sessionDir = this.sessionDirFor(
      path.join(this.rootDir, input.sessionId, WORKSPACE_DIR_NAME),
    );
    await removeWorkspacePath(sessionDir);
    const workspacePath = path.join(sessionDir, WORKSPACE_DIR_NAME);
    await mkdir(workspacePath, { recursive: true });
    return { workspacePath };
  }

  async removeWorkspace(workspacePath: string): Promise<void> {
    await removeWorkspacePath(this.sessionDirFor(workspacePath));
  }

  private sessionDirFor(workspacePath: string): string {
    const resolved = path.resolve(workspacePath);
    const sessionDir = path.dirname(resolved);
    if (
      path.basename(resolved) !== WORKSPACE_DIR_NAME ||
      path.dirname(sessionDir) !== this.rootDir
    ) {
      throw new Error(
        `Refusing to manage workspace outside ${this.rootDir}: ${workspacePath}`,
      );
    }
    return sessionDir;
  }
}
