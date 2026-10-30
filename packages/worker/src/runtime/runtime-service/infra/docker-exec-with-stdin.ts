import { spawn } from "node:child_process";

/** Single-quote a value for safe interpolation into a `sh -c` command. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run `docker` with the given args, piping `stdin` to the child's stdin and
 * closing it. Unlike `execFile`, this can stream content over stdin, which is
 * how `DevcontainerOpencodeBootstrap.prepareAgentHome` seeds the global config
 * and the bundled skills into the container via `docker exec -i ...`.
 *
 * `stdin` may contain secrets (a user config can embed provider keys). It is
 * NEVER logged here and MUST NOT be logged by callers.
 */
export function execDockerWithStdin(
  args: string[],
  stdin: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `docker ${args[0] ?? ""} exited with code ${String(code)}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
      }
    });
    child.stdin.end(stdin);
  });
}
