/**
 * Runs the real `CODE_STEP_RUNNER_SCRIPT_SOURCE` under bun in a temp
 * workspace, laid out like a cloned repo: the step's module and the runner
 * sit in `.scarn/pipeline-builder/`, and `@scarn/sdk` resolves from a
 * `node_modules` above them, as it does in a project's checkout.
 *
 *   - finds a step exported by name (including a callable `codeStep` handle),
 *     and one embedded only in the default pipeline, and writes its result to
 *     the findings file;
 *   - passes `{ artifactsDir, fail }` as the second argument, creating the
 *     folder;
 *   - writes the error file for a thrown `StepError`, recognised by its brand
 *     (so also one from another SDK copy), and not for any other throw;
 *   - fails with a clear stderr message when the key is not in the module,
 *     is ambiguous, or the installed SDK has no `code-step-lookup`;
 *   - runs end to end through `executeCodeStep` and the default command
 *     runner, which also removes the runner afterwards.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CODE_STEP_RUNNER_SCRIPT_SOURCE } from "../../../../src/work/task-run/application/code-step-runner-script";
import {
  defaultRunCodeStepCommand,
  executeCodeStep,
} from "../../../../src/work/task-run/application/execute-code-step";
import { NamedStepError } from "../../../../src/work/task-run/application/named-step-error";

const execFileAsync = promisify(execFile);

const SDK_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../sdks/js",
);
const SOURCE_FILE = ".scarn/pipeline-builder/step.mjs";

const stepSource = (key: string, fnSource: string) =>
  `{ key: "${key}", name: "${key}", version: 1, kind: "code", entrypoint: { fn: ${fnSource} } }`;

const EXPORTED_STEP_MODULE = `
export function helper(n) { return n * 2; }
export const doubleStep = ${stepSource("double", "(input) => ({ doubled: helper(input.n) })")};
`;

const CLOSURE_STEP_MODULE = `
const offset = 100;
export const shiftStep = ${stepSource("shift", "(input) => ({ shifted: input.n + offset })")};
`;

const AMBIGUOUS_MODULE = `
export const first = ${stepSource("twice", "() => ({ which: 1 })")};
export const second = ${stepSource("twice", "() => ({ which: 2 })")};
`;

describe("code step runner script", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-code-step-runner-"),
    );
    await mkdir(path.join(workspacePath, ".scarn", "pipeline-builder"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function linkRealSdk(): Promise<void> {
    const scopeDir = path.join(workspacePath, "node_modules", "@scarn");
    await mkdir(scopeDir, { recursive: true });
    await symlink(SDK_PACKAGE_DIR, path.join(scopeDir, "sdk"));
  }

  async function installSdk(files: Record<string, string>): Promise<void> {
    const sdkDir = path.join(workspacePath, "node_modules", "@scarn", "sdk");
    await mkdir(sdkDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(sdkDir, name), content);
    }
  }

  async function runRunner(input: {
    moduleSource: string;
    stepKey: string;
    stepInput?: unknown;
  }): Promise<{
    exitCode: number;
    stderr: string;
    findings: unknown;
    stepError: unknown;
  }> {
    const pipelineDir = path.join(workspacePath, ".scarn", "pipeline-builder");
    const runnerPath = path.join(pipelineDir, ".code-step-runner-test.mjs");
    const entrypointPath = path.join(workspacePath, SOURCE_FILE);
    const inputPath = path.join(workspacePath, "input.json");
    const findingsPath = path.join(workspacePath, "findings.json");
    const artifactsDir = path.join(workspacePath, ".scarn", "step-artifacts");
    const errorPath = path.join(workspacePath, ".scarn", "tmp", "error.json");
    await writeFile(entrypointPath, input.moduleSource);
    await writeFile(runnerPath, CODE_STEP_RUNNER_SCRIPT_SOURCE);
    await writeFile(inputPath, JSON.stringify(input.stepInput ?? null));

    let exitCode = 0;
    let stderr = "";
    try {
      await execFileAsync(process.execPath, [
        "run",
        runnerPath,
        entrypointPath,
        input.stepKey,
        inputPath,
        findingsPath,
        artifactsDir,
        errorPath,
      ]);
    } catch (error) {
      const execError = error as { code?: number; stderr?: string };
      exitCode = typeof execError.code === "number" ? execError.code : 1;
      stderr = execError.stderr ?? "";
    }

    const readJson = (file: string) =>
      readFile(file, "utf8").then(
        (text) => JSON.parse(text) as unknown,
        () => null,
      );
    return {
      exitCode,
      stderr,
      findings: await readJson(findingsPath),
      stepError: await readJson(errorPath),
    };
  }

  test("runs a step exported by name, with the module's helpers in scope", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: EXPORTED_STEP_MODULE,
      stepKey: "double",
      stepInput: { n: 21 },
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual({ findingsJson: { doubled: 42 } });
  });

  test("runs a callable handle built with the SDK's codeStep", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: `
import { codeStep } from "@scarn/sdk/definitions/steps";
export const triple = codeStep({
  key: "triple",
  name: "Triple",
  fn: (input) => ({ tripled: input.n * 3 }),
});
`,
      stepKey: "triple",
      stepInput: { n: 7 },
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual({ findingsJson: { tripled: 21 } });
  });

  test("runs an exported step that closes over module-level state", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: CLOSURE_STEP_MODULE,
      stepKey: "shift",
      stepInput: { n: 5 },
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual({ findingsJson: { shifted: 105 } });
  });

  test("passes { artifactsDir } as the second argument, with the folder already created", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: `
import { writeFile } from "node:fs/promises";
import path from "node:path";
export const s = ${stepSource(
        "record",
        `async (_input, { artifactsDir }) => {
          await writeFile(path.join(artifactsDir, "clip.webm"), "bytes");
          return { artifactsDir, clip: "clip.webm" };
        }`,
      )};`,
      stepKey: "record",
    });

    const artifactsDir = path.join(workspacePath, ".scarn", "step-artifacts");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual({
      findingsJson: { artifactsDir, clip: "clip.webm" },
    });
    expect(await readFile(path.join(artifactsDir, "clip.webm"), "utf8")).toBe(
      "bytes",
    );
  });

  test("fails with a clear message when the module holds no code step with the key", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: EXPORTED_STEP_MODULE,
      stepKey: "missing",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `no code step with key "missing" exported by ${path.join(workspacePath, SOURCE_FILE)}`,
    );
    expect(result.findings).toBeNull();
  });

  test("fails with the lookup's message when two distinct functions share the key", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: AMBIGUOUS_MODULE,
      stepKey: "twice",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Code step "twice" is ambiguous');
    expect(result.findings).toBeNull();
  });

  test("reports a thrown step function with its key", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: `export const s = ${stepSource("boom", '() => { throw new Error("kaput"); }')};`,
      stepKey: "boom",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('code step "boom" threw');
    expect(result.stderr).toContain("kaput");
    expect(result.stepError).toBeNull();
  });

  test("writes the error file when the step throws an SDK StepError", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: `
import { StepError, codeStep } from "@scarn/sdk/definitions/steps";
export const s = codeStep({
  key: "declined",
  name: "Declined",
  errors: ["Billing.Declined"],
  fn: () => {
    throw new StepError("Billing.Declined", "card declined", { code: "CARD_DECLINED" });
  },
});
`,
      stepKey: "declined",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('code step "declined" threw');
    expect(result.stepError).toEqual({
      name: "Billing.Declined",
      code: "CARD_DECLINED",
      message: "card declined",
    });
  });

  test("writes the error file for a branded error from another copy of the SDK", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: `export const s = ${stepSource(
        "foreign",
        `() => {
          const error = new Error("rate limited");
          Object.defineProperty(error, "name", { value: "Scarn.McpUnavailable" });
          error[Symbol.for("scarn.stepError")] = true;
          throw error;
        }`,
      )};`,
      stepKey: "foreign",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stepError).toEqual({
      name: "Scarn.McpUnavailable",
      code: null,
      message: "rate limited",
    });
  });

  test("passes a fail that throws a branded error the runner records", async () => {
    await linkRealSdk();

    const result = await runRunner({
      moduleSource: `export const s = ${stepSource(
        "fails",
        `(_input, { fail }) => fail("Billing.Expired", "card expired", { code: "EXPIRED" })`,
      )};`,
      stepKey: "fails",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stepError).toEqual({
      name: "Billing.Expired",
      code: "EXPIRED",
      message: "card expired",
    });
  });

  test("tells the user to upgrade when the installed SDK has no code-step-lookup subpath", async () => {
    await installSdk({
      "package.json": JSON.stringify({
        name: "@scarn/sdk",
        version: "0.6.0",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "index.js": "export {};",
    });

    const result = await runRunner({
      moduleSource: EXPORTED_STEP_MODULE,
      stepKey: "double",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the installed @scarn/sdk is too old for inline code steps; upgrade it",
    );
    expect(result.stderr).toContain("installed version: 0.6.0");
    expect(result.findings).toBeNull();
  });

  test("tells the user to upgrade when code-step-lookup does not export findCodeStepInModule", async () => {
    await installSdk({
      "package.json": JSON.stringify({
        name: "@scarn/sdk",
        type: "module",
        exports: { "./code-step-lookup": "./lookup.js" },
      }),
      "lookup.js": "export const somethingElse = 1;",
    });

    const result = await runRunner({
      moduleSource: EXPORTED_STEP_MODULE,
      stepKey: "double",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the installed @scarn/sdk is too old for inline code steps; upgrade it",
    );
    expect(result.stderr).toContain("installed version: unknown");
  });

  test("runs end to end through executeCodeStep and leaves no runner behind", async () => {
    await linkRealSdk();
    await writeFile(path.join(workspacePath, SOURCE_FILE), CLOSURE_STEP_MODULE);

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: SOURCE_FILE },
        stepKey: "shift",
        declaredErrors: [],
        inputJson: { n: 1 },
        runtime: "bun",
        stepEnv: {
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env["PATH"] ?? ""}`,
        },
      },
      { runCommand: defaultRunCodeStepCommand },
    );

    const findings = JSON.parse(
      await readFile(
        path.join(workspacePath, ".scarn", "step-findings-submission.json"),
        "utf8",
      ),
    ) as unknown;
    expect(findings).toEqual({ findingsJson: { shifted: 101 } });
    expect(
      await readdir(path.join(workspacePath, ".scarn", "pipeline-builder")),
    ).toEqual(["step.mjs"]);
  });

  test("end to end, a declared StepError fails as a NamedStepError and leaves no error file", async () => {
    await linkRealSdk();
    await writeFile(
      path.join(workspacePath, SOURCE_FILE),
      `export const s = ${stepSource(
        "declined",
        `(_input, { fail }) => fail("Billing.Declined", "card declined")`,
      )};`,
    );

    let failure: unknown;
    try {
      await executeCodeStep(
        {
          environment: {
            workspacePath,
            workspaceFolder: workspacePath,
            runtimeContainerId: null,
          },
          entrypointJson: { sourceFile: SOURCE_FILE },
          stepKey: "declined",
          declaredErrors: ["Billing.Declined"],
          inputJson: null,
          runtime: "bun",
          stepEnv: {
            PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env["PATH"] ?? ""}`,
          },
        },
        { runCommand: defaultRunCodeStepCommand },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NamedStepError);
    expect(failure).toMatchObject({
      errorName: "Billing.Declined",
      code: "SCARN_STEP_ERROR",
    });
    expect(await readdir(path.join(workspacePath, ".scarn", "tmp"))).toEqual(
      [],
    );
  });
});
