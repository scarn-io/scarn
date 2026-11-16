import { afterEach, describe, expect, test, vi } from "bun:test";
import type { EnvVarSpec } from "@scarn/sdk/env-vars";
import {
  planDryRunSecretEnv,
  resolveSecretEnv,
  type RequestProjectSecrets,
} from "../../../../src/work/task-run/application/resolve-secret-env";
import {
  MissingStepEnvError,
  resolveStepEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";

const secret = (
  name: string,
  secretName = name,
  applies: "agent" | "setup" | "both" = "agent",
): EnvVarSpec => ({ name, source: "secret", secretName, applies });

function scarnReturning(
  secrets: Record<string, string>,
): ReturnType<typeof vi.fn<RequestProjectSecrets>> {
  return vi.fn<RequestProjectSecrets>((names) =>
    Promise.resolve({
      secrets: Object.fromEntries(
        names
          .filter((name) => secrets[name] !== undefined)
          .map((name) => [name, { value: secrets[name] ?? "" }]),
      ),
      missing: names.filter((name) => secrets[name] === undefined),
    }),
  );
}

describe("resolveSecretEnv", () => {
  afterEach(() => {
    delete process.env["SHELL_SECRET"];
  });

  test("the worker's .scarn/.env value beats the Scarn value", async () => {
    const requestSecrets = scarnReturning({
      DD_KEY: "scarn-value",
      OTHER: "scarn-other",
    });
    const result = await resolveSecretEnv({
      envVars: [secret("DD_API_KEY", "DD_KEY"), secret("OTHER")],
      localEnvVars: { DD_KEY: "worker-value" },
      requestSecrets,
    });

    expect(requestSecrets).toHaveBeenCalledTimes(1);
    expect(requestSecrets).toHaveBeenCalledWith(["OTHER"]);
    expect(result.values).toEqual({
      DD_KEY: "worker-value",
      OTHER: "scarn-other",
    });
    expect(result.sources).toEqual({ DD_KEY: "worker", OTHER: "scarn" });
  });

  test("makes no call when .scarn/.env has every name", async () => {
    const requestSecrets = scarnReturning({});
    const result = await resolveSecretEnv({
      envVars: [secret("A_TOKEN"), secret("B_TOKEN", "A_TOKEN", "setup")],
      localEnvVars: { A_TOKEN: "local" },
      requestSecrets,
    });

    expect(requestSecrets).not.toHaveBeenCalled();
    expect(result.values).toEqual({ A_TOKEN: "local" });
  });

  test("makes no call when no var reads a secret", async () => {
    const requestSecrets = scarnReturning({});
    await resolveSecretEnv({ envVars: [], localEnvVars: {}, requestSecrets });
    expect(requestSecrets).not.toHaveBeenCalled();
  });

  test("ignores process.env for secret vars", async () => {
    process.env["SHELL_SECRET"] = "from-the-shell";
    const requestSecrets = scarnReturning({ SHELL_SECRET: "from-scarn" });
    const result = await resolveSecretEnv({
      envVars: [secret("SHELL_SECRET")],
      localEnvVars: {},
      requestSecrets,
    });

    expect(requestSecrets).toHaveBeenCalledWith(["SHELL_SECRET"]);
    expect(result.values).toEqual({ SHELL_SECRET: "from-scarn" });
    expect(() =>
      resolveStepEnv({
        envVars: [secret("SHELL_SECRET")],
        inputJson: {},
        workerEnv: { ...process.env },
        projectSecrets: {},
      }),
    ).toThrow(MissingStepEnvError);
  });

  test("requests each secret name once", async () => {
    const requestSecrets = scarnReturning({ SHARED: "v" });
    await resolveSecretEnv({
      envVars: [secret("A", "SHARED"), secret("B", "SHARED")],
      localEnvVars: {},
      requestSecrets,
    });
    expect(requestSecrets).toHaveBeenCalledWith(["SHARED"]);
  });
});

describe("resolveStepEnv with project secrets", () => {
  test("routes secret values by applies and masks them", () => {
    const result = resolveStepEnv({
      envVars: [
        secret("AGENT_KEY", "K1"),
        secret("SETUP_KEY", "K2", "setup"),
        secret("BOTH_KEY", "K3", "both"),
      ],
      inputJson: {},
      workerEnv: {},
      projectSecrets: { K1: "value-one", K2: "value-two", K3: "value-three" },
    });

    expect(result.stepEnv).toEqual({
      AGENT_KEY: "value-one",
      BOTH_KEY: "value-three",
    });
    expect(result.setupEnv).toEqual({
      SETUP_KEY: "value-two",
      BOTH_KEY: "value-three",
    });
    expect(result.promptEnv).toEqual({});
    expect(result.secretValues).toEqual([
      "value-one",
      "value-two",
      "value-three",
    ]);
  });

  test("fails once listing every missing secret and worker var", () => {
    let error: unknown;
    try {
      resolveStepEnv({
        envVars: [
          secret("DD_API_KEY", "DD_KEY"),
          {
            name: "AWS_PROFILE",
            source: "inherit",
            from: "AWS_PROFILE",
            secret: false,
            optional: false,
            applies: "agent",
          },
          secret("GH_TOKEN"),
        ],
        inputJson: {},
        workerEnv: {},
        projectSecrets: {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MissingStepEnvError);
    const missingError = error as MissingStepEnvError;
    expect(missingError.missing).toEqual([
      "DD_KEY (project secret for DD_API_KEY)",
      "AWS_PROFILE",
      "GH_TOKEN (project secret)",
    ]);
    expect(missingError.message).toContain(
      "set it in .scarn/.env or save it as a project secret",
    );
  });
});

describe("planDryRunSecretEnv", () => {
  test("reports each secret's source without fetching from Scarn", () => {
    const plan = planDryRunSecretEnv(
      [secret("DD_API_KEY", "DD_KEY"), secret("LOCAL")],
      { LOCAL: "local-value" },
    );

    expect(plan.secrets).toEqual([
      { name: "DD_API_KEY", secretName: "DD_KEY", source: "scarn" },
      { name: "LOCAL", secretName: "LOCAL", source: "worker" },
    ]);
    expect(plan.values).toEqual({ DD_KEY: "", LOCAL: "local-value" });
  });
});
