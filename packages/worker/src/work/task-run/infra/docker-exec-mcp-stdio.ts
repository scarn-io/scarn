import path from "node:path";
import type { LocalMcpLaunch } from "../../../common/infra/mcp-transport";
import {
  buildDockerEnvByName,
  dockerProcessEnv,
} from "../../../runtime/runtime-service/infra/docker-env-flags";

/**
 * argv for running a `local` MCP server inside a container over
 * `docker exec -i`, and for stopping it again.
 *
 * Env is passed by name (`-e NAME`) with the values on the `docker` CLI's own
 * environment, so they never appear in argv. The server runs under
 * `sh -c 'echo $$ > <pidFile> && exec "$@"'`: `docker exec` makes it a session
 * (and process group) leader, so the pid it records is also the group id, and
 * {@link buildContainerMcpStopArgs} can signal the whole group. Killing the
 * `docker` CLI alone does not stop the process inside the container.
 */

export type ContainerMcpStdioLaunch = {
  command: "docker";
  args: string[];
  env: Record<string, string>;
};

const RECORD_PID_AND_EXEC = 'echo $$ > "$0" && exec "$@"';

const STOP_PROCESS_GROUP = [
  'p=$(cat "$0" 2>/dev/null) || exit 0',
  'kill -TERM -"$p" 2>/dev/null',
  "i=0",
  'while kill -0 -"$p" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done',
  'kill -KILL -"$p" 2>/dev/null',
  'rm -f "$0"',
  "exit 0",
].join("; ");

export function buildContainerMcpStdioLaunch(input: {
  containerId: string;
  workspaceDir: string;
  launch: LocalMcpLaunch;
  env: Readonly<Record<string, string>>;
  pidFile: string;
}): ContainerMcpStdioLaunch {
  const byName = buildDockerEnvByName(input.env, input.launch.environment);
  return {
    command: "docker",
    args: [
      "exec",
      "-i",
      "-w",
      path.posix.resolve(input.workspaceDir, input.launch.cwd ?? "."),
      ...byName.flags,
      input.containerId,
      "sh",
      "-c",
      RECORD_PID_AND_EXEC,
      input.pidFile,
      ...input.launch.command,
    ],
    env: definedOnly(dockerProcessEnv(byName)),
  };
}

/**
 * `docker` args that SIGTERM the server's process group, SIGKILL it after
 * ~2s if it is still alive, and remove the pid file. A no-op when the pid
 * file is missing (the server never started).
 */
export function buildContainerMcpStopArgs(input: {
  containerId: string;
  pidFile: string;
}): string[] {
  return [
    "exec",
    input.containerId,
    "sh",
    "-c",
    STOP_PROCESS_GROUP,
    input.pidFile,
  ];
}

function definedOnly(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
