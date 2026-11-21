import { describe, expect, test } from "bun:test";
import {
  buildContainerMcpStdioLaunch,
  buildContainerMcpStopArgs,
} from "../../../../src/work/task-run/infra/docker-exec-mcp-stdio";

describe("buildContainerMcpStdioLaunch", () => {
  const launch = buildContainerMcpStdioLaunch({
    containerId: "c1",
    workspaceDir: "/workspaces/repo",
    launch: {
      command: ["npx", "-y", "server"],
      environment: { API_KEY: "server-secret" },
      cwd: "tools/mcp",
    },
    env: { STEP_TOKEN: "step-secret", API_KEY: "overridden" },
    pidFile: "/tmp/scarn-mcp-1.pid",
  });

  test("runs the server under a pid-recording sh in the resolved cwd", () => {
    expect(launch.command).toBe("docker");
    expect(launch.args).toEqual([
      "exec",
      "-i",
      "-w",
      "/workspaces/repo/tools/mcp",
      "-e",
      "STEP_TOKEN",
      "-e",
      "API_KEY",
      "c1",
      "sh",
      "-c",
      'echo $$ > "$0" && exec "$@"',
      "/tmp/scarn-mcp-1.pid",
      "npx",
      "-y",
      "server",
    ]);
  });

  test("passes env values only on the docker CLI's environment", () => {
    expect(launch.args.join(" ")).not.toContain("secret");
    expect(launch.env["STEP_TOKEN"]).toBe("step-secret");
    expect(launch.env["API_KEY"]).toBe("server-secret");
    expect(launch.env["PATH"]).toBe(process.env["PATH"]);
  });

  test("defaults the cwd to the workspace dir and keeps an absolute cwd", () => {
    const base = {
      containerId: "c1",
      workspaceDir: "/workspaces/repo",
      env: {},
      pidFile: "/tmp/p",
    };
    const workdirOf = (cwd: string | undefined) =>
      buildContainerMcpStdioLaunch({
        ...base,
        launch: { command: ["srv"], environment: {}, cwd },
      }).args[3];

    expect(workdirOf(undefined)).toBe("/workspaces/repo");
    expect(workdirOf("/opt/srv")).toBe("/opt/srv");
  });
});

describe("buildContainerMcpStopArgs", () => {
  test("signals the recorded process group inside the container", () => {
    const args = buildContainerMcpStopArgs({
      containerId: "c1",
      pidFile: "/tmp/scarn-mcp-1.pid",
    });

    expect(args.slice(0, 4)).toEqual(["exec", "c1", "sh", "-c"]);
    expect(args[4]).toContain('kill -TERM -"$p"');
    expect(args[4]).toContain('kill -KILL -"$p"');
    expect(args[5]).toBe("/tmp/scarn-mcp-1.pid");
  });
});
