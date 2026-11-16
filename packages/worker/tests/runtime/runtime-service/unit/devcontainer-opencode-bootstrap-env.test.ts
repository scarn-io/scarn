/**
 * Unit test for how {@link DevcontainerOpencodeBootstrap.start} hands provider
 * and step variables to `docker exec`. A fake `docker` on `PATH` records each
 * invocation's argv and environment; the liveness probe reports the process
 * dead so `start()` fails fast after the serve exec.
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
import { DevcontainerOpencodeBootstrap } from "../../../../src/runtime/runtime-service/infra/devcontainer-opencode-bootstrap";
import { SERVER_PASSWORD_ENV } from "../../../../src/runtime/runtime-service/infra/opencode-server-contract";

type DockerCall = { args: string[]; env: Record<string, string | undefined> };

const RECORDED_NAMES = [
  "PROVIDER_TOKEN",
  "SHARED",
  "STEP_TOKEN",
  SERVER_PASSWORD_ENV,
];

describe("DevcontainerOpencodeBootstrap.start step variables", () => {
  let tempDir: string;
  let callsPath: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "devcontainer-env-"));
    callsPath = path.join(tempDir, "calls.jsonl");
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir);
    const recorder = path.join(tempDir, "record.ts");
    await writeFile(
      recorder,
      [
        `import { appendFileSync } from "node:fs";`,
        `const names = ${JSON.stringify(RECORDED_NAMES)};`,
        `const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));`,
        `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args: process.argv.slice(2), env }) + "\\n");`,
        `if (process.argv.at(-1)?.includes("/proc/")) console.log("dead");`,
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

  async function readServeCall(): Promise<DockerCall> {
    const raw = await readFile(callsPath, "utf8");
    const calls = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DockerCall);
    const serve = calls.find((call) => call.args.at(-1)?.includes(" serve "));
    if (!serve) throw new Error("no serve exec recorded");
    return serve;
  }

  test("names variables in argv and passes their values through the docker process env", async () => {
    let caught: unknown;
    try {
      await new DevcontainerOpencodeBootstrap().start({
        containerId: "container-1",
        workspaceFolder: "/workspaces/repo",
        hostPort: 1,
        launchWrapperPath: "/opt/scarn/launch.sh",
        expectedVersion: "2.1.4",
        providerEnv: { PROVIDER_TOKEN: "provider-secret", SHARED: "provider" },
        credentials: [],
        stepEnv: { STEP_TOKEN: "step-secret", SHARED: "step" },
        opencodeConfigContent: "{}",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain(
      "exited before becoming healthy",
    );

    const serve = await readServeCall();
    const argv = serve.args.join("\n");
    expect(argv).not.toContain("provider-secret");
    expect(argv).not.toContain("step-secret");
    expect(argv).not.toContain(`${SERVER_PASSWORD_ENV}=`);
    for (const name of RECORDED_NAMES) {
      const flagIndexes = serve.args.flatMap((arg, index) =>
        arg === name && serve.args[index - 1] === "-e" ? [index] : [],
      );
      expect(flagIndexes).toHaveLength(1);
    }
    expect(serve.env).toMatchObject({
      PROVIDER_TOKEN: "provider-secret",
      STEP_TOKEN: "step-secret",
      SHARED: "step",
    });
    expect(serve.env[SERVER_PASSWORD_ENV]).toMatch(/.+/);
  });
});
