import { spawn } from "node:child_process";
import os from "node:os";
import type {
  GitCredentialSource,
  GitCredentialSourceFactory,
} from "../application/git-credential-source";
import {
  parseGitCredential,
  serializeGitCredentialQuery,
  type GitCredential,
  type GitCredentialQuery,
} from "../domain/git-credential-protocol";

/**
 * The worker host's own git credentials, via `git credential fill`.
 *
 * Nothing may ever prompt on the worker: `GIT_TERMINAL_PROMPT=0`, empty
 * `GIT_ASKPASS` / `SSH_ASKPASS`, no stdin beyond the query, and a timeout.
 * A non-zero exit or an answer without a password is `null`. Stdout is held
 * in memory only: it is never logged, and errors carry the exit status only.
 */

export type HostGitCredentialSourceOptions = {
  /** Env `git` inherits before the no-prompt overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  cwd?: string | undefined;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export class HostGitCredentialSource implements GitCredentialSource {
  readonly mode = "host" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(options: HostGitCredentialSourceOptions = {}) {
    this.env = {
      ...(options.env ?? process.env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = options.cwd ?? os.tmpdir();
  }

  async get(query: GitCredentialQuery): Promise<GitCredential | null> {
    const stdout = await this.fill(`${serializeGitCredentialQuery(query)}\n`);
    return stdout === null ? null : parseGitCredential(stdout);
  }

  private fill(input: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["credential", "fill"], {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `git credential fill timed out after ${String(this.timeoutMs)}ms`,
          ),
        );
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stdin.on("error", () => undefined);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(`git credential fill failed to spawn: ${error.message}`),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
      });
      child.stdin.end(input);
    });
  }
}

export const hostGitCredentialSourceFactory: GitCredentialSourceFactory = () =>
  new HostGitCredentialSource();
