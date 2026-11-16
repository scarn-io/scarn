import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CATALOG,
  ConnectorMcpCollision,
  ConnectorVarsMissing,
  connectorDefinitions,
  E2E_FAKE_CONNECTOR,
  E2E_FAKE_CONNECTOR_FLAG,
  listConnectorSummaries,
  mergeConnectorMcpServers,
  validateConnectorCatalog,
  type ConnectorDefinition,
} from "../src/connectors";
import {
  EnvironmentInvalid,
  environmentRefSchema,
  type ResolvedEnvironmentRefInput,
} from "../src/environment";
import {
  resolveEnvironment,
  type ResolveEnvironmentDeps,
} from "../src/resolve-environment";
import { compileEnvironment } from "../src/definitions/steps/runtime";

const remote = (
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition => ({
  id: "acme",
  name: "Acme",
  description: "Acme",
  auth: "apiKey",
  requiredVars: [{ name: "ACME_KEY", description: "key" }],
  mcp: {
    type: "remote",
    url: "https://acme.test/mcp",
    headers: { Authorization: "Bearer {env:ACME_KEY}" },
  },
  ...overrides,
});

const deps: ResolveEnvironmentDeps = {
  devcontainerExists: () => Promise.resolve(false),
};

const named = (
  name: string,
  content: Extract<
    ResolvedEnvironmentRefInput,
    { content: unknown }
  >["content"],
): ResolvedEnvironmentRefInput => ({
  kind: "named",
  name,
  version: 3,
  content,
});

describe("connector catalog", () => {
  test("the shipped catalog is valid and has playwright and datadog", () => {
    expect(validateConnectorCatalog(Object.values(CONNECTOR_CATALOG))).toEqual(
      [],
    );
    expect(Object.keys(CONNECTOR_CATALOG).sort()).toEqual([
      "datadog",
      "playwright",
    ]);
    expect(
      CONNECTOR_CATALOG["datadog"]?.requiredVars.map((v) => v.name),
    ).toEqual(["DD_API_KEY", "DD_APPLICATION_KEY"]);
  });

  test("the e2e fake joins the catalog only behind its flag", () => {
    expect(validateConnectorCatalog([E2E_FAKE_CONNECTOR])).toEqual([]);
    expect(connectorDefinitions({}).map((entry) => entry.id)).not.toContain(
      "e2e-fake",
    );
    expect(
      connectorDefinitions({ [E2E_FAKE_CONNECTOR_FLAG]: "1" }).map(
        (entry) => entry.id,
      ),
    ).not.toContain("e2e-fake");
    expect(
      connectorDefinitions({ [E2E_FAKE_CONNECTOR_FLAG]: "true" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["playwright", "datadog", "e2e-fake"]);
  });

  test("a valid entry passes", () => {
    expect(validateConnectorCatalog([remote()])).toEqual([]);
  });

  test.each([
    ["non-kebab id", [remote({ id: "Acme_Co" })], "kebab-case"],
    ["duplicate id", [remote(), remote()], "duplicate id"],
    [
      "placeholder not in requiredVars",
      [remote({ requiredVars: [], auth: "none" })],
      "requiredVars omits it",
    ],
    [
      "requiredVar never read",
      [
        remote({
          requiredVars: [
            { name: "ACME_KEY", description: "key" },
            { name: "ACME_EXTRA", description: "extra" },
          ],
        }),
      ],
      "mcp never reads it",
    ],
    [
      "literal header",
      [
        remote({
          mcp: {
            type: "remote",
            url: "https://acme.test/mcp",
            headers: { Authorization: "Bearer abc", X: "{env:ACME_KEY}" },
          },
        }),
      ],
      "must be {env:NAME} placeholders",
    ],
  ])("rejects %s", (_label, entries, message) => {
    expect(validateConnectorCatalog(entries).join("\n")).toContain(message);
  });

  test("summaries carry no mcp config", () => {
    for (const summary of listConnectorSummaries()) {
      expect(summary).not.toHaveProperty("mcp");
    }
  });
});

describe("environment connectors", () => {
  test("an unknown connector id is EnvironmentInvalid", async () => {
    const result = await resolveEnvironment(
      deps,
      named("env", { connectors: ["nope"] }),
    );
    expect(result).toBeInstanceOf(EnvironmentInvalid);
    expect((result as Error).message).toContain("environment env v3");
    expect((result as Error).message).toContain('unknown connector "nope"');
  });

  test("duplicate connector ids are rejected inline too", () => {
    expect(
      environmentRefSchema.safeParse({
        kind: "inline",
        connectors: ["playwright", "playwright"],
      }).success,
    ).toBe(false);
  });

  test("missing required vars fail with SCARN_CONNECTOR_VARS_MISSING", async () => {
    const result = await resolveEnvironment(
      deps,
      named("obs", {
        connectors: ["datadog", "playwright"],
        vars: [
          { name: "DD_API_KEY", source: "secret", secretName: "DD_API_KEY" },
        ],
      }),
    );
    expect(result).toBeInstanceOf(ConnectorVarsMissing);
    const error = result as ConnectorVarsMissing;
    expect(error.code).toBe("SCARN_CONNECTOR_VARS_MISSING");
    expect(error.missing).toEqual([
      { connector: "datadog", vars: ["DD_APPLICATION_KEY"] },
    ]);
    expect(error.environment).toBe("environment obs v3");
    expect(error.message).toContain("environment obs v3");
    expect(error.message).toContain("datadog needs DD_APPLICATION_KEY");
  });

  test("a setup-only var does not satisfy a connector", async () => {
    const result = await resolveEnvironment(deps, {
      kind: "inline",
      runtime: { kind: "managed", id: "bun1" },
      envJson: [
        { name: "DD_API_KEY", source: "secret", secretName: "K" },
        {
          name: "DD_APPLICATION_KEY",
          source: "secret",
          secretName: "A",
          applies: "setup",
        },
      ],
      connectors: ["datadog"],
    });
    expect(result).toBeInstanceOf(ConnectorVarsMissing);
  });

  test("vars from any source satisfy a connector", async () => {
    const result = await resolveEnvironment(
      deps,
      named("obs", {
        connectors: ["datadog"],
        vars: [
          {
            name: "DD_API_KEY",
            source: "secret",
            secretName: "DATADOG_API_KEY",
          },
          {
            name: "DD_APPLICATION_KEY",
            source: "inherit",
            from: "DD_APP_KEY",
            secret: true,
            optional: false,
          },
        ],
      }),
    );
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toMatchObject({ connectors: ["datadog"] });
  });

  test("compileEnvironment carries connectors and rejects unknown ids", () => {
    expect(compileEnvironment({ connectors: ["playwright"] })).toMatchObject({
      kind: "inline",
      connectors: ["playwright"],
    });
    expect(() =>
      compileEnvironment({ connectors: ["nope"] }, { stepKey: "s" }),
    ).toThrow('Step "s" environment connectors: unknown connector "nope"');
  });
});

describe("mergeConnectorMcpServers", () => {
  test("adds each connector under its id beside the step's servers", () => {
    const merged = mergeConnectorMcpServers(["datadog"], {
      mine: { type: "local", command: ["mine"] },
    });
    expect(Object.keys(merged ?? {}).sort()).toEqual(["datadog", "mine"]);
    expect(merged?.["datadog"]).toEqual(CONNECTOR_CATALOG["datadog"]?.mcp);
    expect(merged?.["datadog"]).not.toBe(CONNECTOR_CATALOG["datadog"]?.mcp);
  });

  test("no connectors leaves the servers untouched", () => {
    expect(mergeConnectorMcpServers([], null)).toBeNull();
  });

  test("a step key that reuses a connector id throws", () => {
    expect(() =>
      mergeConnectorMcpServers(["playwright"], {
        playwright: { type: "local", command: ["x"] },
      }),
    ).toThrow(ConnectorMcpCollision);
  });

  test("a non-step entry under a connector id is replaced", () => {
    const merged = mergeConnectorMcpServers(
      ["playwright"],
      { playwright: { type: "local", command: ["x"], disabled: true } },
      [],
    );
    expect(merged?.["playwright"]).toEqual(
      CONNECTOR_CATALOG["playwright"]?.mcp,
    );
  });
});
