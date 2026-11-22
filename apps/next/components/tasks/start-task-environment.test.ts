import { describe, expect, test } from "bun:test";
import {
  buildEnvironmentInput,
  effectiveEnvironmentFacts,
  lockedConnectors,
  mapStartTaskError,
  varsToName,
} from "./start-task-environment";

const datadog = {
  id: "datadog",
  name: "Datadog",
  requiredVars: [
    { name: "DD_API_KEY", description: "API key" },
    { name: "DD_APP_KEY", description: "App key" },
  ],
};

const problem = (code: string, meta?: Record<string, unknown>) => ({
  status: 422,
  value: { status: 422, code, detail: `failed: ${code}`, meta },
});

describe("lockedConnectors", () => {
  test("names the environment and the step's MCP servers as sources", () => {
    expect(
      lockedConnectors({
        mode: "step",
        step: {
          environment: { kind: "named", name: "base" },
          opencodeMcpJson: { linear: { type: "remote", url: "https://x" } },
        },
        override: "",
        environment: { connectors: ["github"] },
      }),
    ).toEqual([
      { id: "github", note: 'From environment "base"' },
      { id: "linear", note: "From the step's MCP servers" },
    ]);
  });

  test("has none for the repo default", () => {
    expect(
      lockedConnectors({
        mode: "prompt",
        step: null,
        override: "",
        environment: null,
      }),
    ).toEqual([]);
  });
});

describe("effectiveEnvironmentFacts", () => {
  test("uses the step's inline environment and ignores an override", () => {
    expect(
      effectiveEnvironmentFacts(
        "step",
        {
          environment: { kind: "inline", connectors: ["github"] },
          opencodeMcpJson: null,
        },
        "staging",
        { connectors: ["sentry"] },
      ),
    ).toEqual({ connectors: ["github"], vars: [] });
  });
});

describe("varsToName", () => {
  test("skips vars the environment gives the agent, not setup-only ones", () => {
    expect(
      varsToName(datadog, {
        vars: [
          { name: "DD_API_KEY", applies: "agent" },
          { name: "DD_APP_KEY", applies: "setup" },
        ],
      }),
    ).toEqual(["DD_APP_KEY"]);
  });
});

describe("buildEnvironmentInput", () => {
  const base = {
    override: "",
    extras: [] as string[],
    catalog: [datadog],
    environment: null,
    drafts: {},
    savedSecretNames: [] as string[],
  };

  test("is undefined when nothing is chosen", () => {
    expect(buildEnvironmentInput(base)).toBeUndefined();
  });

  test("pre-fills saved secrets of the same name and keeps typed names", () => {
    expect(
      buildEnvironmentInput({
        ...base,
        override: "staging",
        extras: ["datadog"],
        savedSecretNames: ["DD_API_KEY"],
        drafts: { datadog: { DD_APP_KEY: " DD_STAGING_APP " } },
      }),
    ).toEqual({
      name: "staging",
      extraConnectors: [
        {
          connectorId: "datadog",
          vars: {
            DD_API_KEY: { secret: "DD_API_KEY" },
            DD_APP_KEY: { secret: "DD_STAGING_APP" },
          },
        },
      ],
    });
  });

  test("is null while a var has no valid secret name", () => {
    expect(buildEnvironmentInput({ ...base, extras: ["datadog"] })).toBeNull();
    expect(
      buildEnvironmentInput({
        ...base,
        extras: ["datadog"],
        drafts: { datadog: { DD_API_KEY: "lower", DD_APP_KEY: "OK" } },
      }),
    ).toBeNull();
  });
});

describe("mapStartTaskError", () => {
  test("puts environment errors on the Environment field", () => {
    for (const code of [
      "ENVIRONMENT_OVERRIDE_INLINE",
      "ENVIRONMENT_NOT_FOUND",
      "ENVIRONMENT_OVERRIDE_INCOMPATIBLE",
    ]) {
      expect(mapStartTaskError(problem(code).value)).toEqual({
        environment: `failed: ${code}`,
      });
    }
  });

  test("puts unknown or duplicate connectors on the Connectors field", () => {
    for (const code of ["CONNECTOR_NOT_FOUND", "CONNECTOR_ALREADY_PRESENT"]) {
      expect(
        mapStartTaskError(problem(code, { connectorId: "datadog" }).value),
      ).toEqual({ connectors: `failed: ${code}` });
    }
  });

  test("puts a missing var on that connector's var field", () => {
    expect(
      mapStartTaskError(
        problem("CONNECTOR_VAR_MISSING", {
          connectorId: "datadog",
          vars: ["DD_APP_KEY"],
        }).value,
      ),
    ).toEqual({
      vars: { datadog: { DD_APP_KEY: "Name a project secret for this var." } },
    });
  });

  test("falls back to a general message", () => {
    expect(mapStartTaskError(new Error("network"))).toEqual({
      general: "Couldn't start the task.",
    });
  });
});
