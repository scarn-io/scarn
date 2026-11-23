/**
 * {@link executeCodeStep} with a step that threw a `StepError`: the runner's
 * error file under `.scarn/tmp/` becomes a `NamedStepError` and is removed.
 * The name validation itself is covered by `named-step-error.test.ts`.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  executeCodeStep,
  type RunCodeStepCommand,
} from "../../../../src/work/task-run/application/execute-code-step";
import { NamedStepError } from "../../../../src/work/task-run/application/named-step-error";

describe("executeCodeStep — named step errors", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-execute-code-step-named-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  test("a non-zero exit with a step error record throws a NamedStepError and removes the record", async () => {
    const logs: string[] = [];
    const runCommand: RunCodeStepCommand = async () => {
      const tmpDir = path.join(workspacePath, ".scarn", "tmp");
      const inputFile = (await readdir(tmpDir)).find((name) =>
        name.startsWith("code-step-input-"),
      );
      const errorFile = (inputFile ?? "").replace(
        "code-step-input-",
        "code-step-error-",
      );
      await writeFile(
        path.join(tmpDir, errorFile),
        JSON.stringify({
          name: "Billing.Declined",
          code: "CARD_DECLINED",
          message: "declined",
        }),
      );
      return { exitCode: 1, stdout: "", stderr: "threw" };
    };

    let failure: unknown;
    try {
      await executeCodeStep(
        {
          environment: {
            workspacePath,
            workspaceFolder: workspacePath,
            runtimeContainerId: null,
          },
          entrypointJson: { sourceFile: "steps/charge.ts" },
          stepKey: "charge",
          declaredErrors: ["Billing.Declined"],
          inputJson: null,
        },
        { runCommand, onLog: (message) => logs.push(message) },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NamedStepError);
    expect(failure).toMatchObject({
      errorName: "Billing.Declined",
      code: "CARD_DECLINED",
    });
    expect((failure as Error).message).toContain("threw");
    expect(logs).toEqual([]);
    expect(await readdir(path.join(workspacePath, ".scarn", "tmp"))).toEqual(
      [],
    );
  });

  test("passes the error file path to the runner under .scarn/tmp", async () => {
    let shellCommand = "";
    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: "/workspaces/repo",
          runtimeContainerId: "container-1",
        },
        entrypointJson: { sourceFile: "steps/charge.ts" },
        stepKey: "charge",
        declaredErrors: [],
        inputJson: null,
      },
      {
        runCommand: (input) => {
          shellCommand = input.shellCommand;
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    );

    expect(shellCommand).toMatch(
      /'\/workspaces\/repo\/\.scarn\/tmp\/code-step-error-[^']+\.json'/,
    );
  });
});
