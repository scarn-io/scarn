/**
 * The Scarn connector catalog: pre-built MCP servers an environment turns on
 * with `connectors: [id, …]`. Each entry's `mcp` reads credentials only
 * through `{env:NAME}` placeholders, and every placeholder is one of its
 * `requiredVars`; the environment's `vars` provide them by any source.
 * `validateConnectorCatalog` enforces this when the module loads.
 */
import {
  collectEnvPlaceholderNames,
  isEnvPlaceholderValue,
  openCodeResolvedMcpServerConfigSchema,
  type ResolvedOpenCodeMcpServerConfig,
} from "../opencode-mcp";
import { ENV_VAR_NAME_PATTERN } from "../env-vars";

/**
 * How a connector authenticates. `none` is for local servers that need no
 * credentials; `apiKey` reads static keys from `requiredVars`. OAuth joins
 * this union in a later slice.
 */
export const connectorAuthValues = ["none", "apiKey"] as const;
export type ConnectorAuth = (typeof connectorAuthValues)[number];

export type ConnectorRequiredVar = {
  name: string;
  description: string;
};

export type ConnectorDefinition = {
  id: string;
  name: string;
  description: string;
  auth: ConnectorAuth;
  requiredVars: readonly ConnectorRequiredVar[];
  mcp: ResolvedOpenCodeMcpServerConfig;
};

/** What the API exposes: everything but the MCP config. */
export type ConnectorSummary = Omit<
  ConnectorDefinition,
  "mcp" | "requiredVars"
> & {
  requiredVars: ConnectorRequiredVar[];
};

const CONNECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    id: "playwright",
    name: "Playwright",
    description:
      "Drive a headless browser: open pages, click, type, read the page and take screenshots.",
    auth: "none",
    requiredVars: [],
    mcp: {
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@0.0.68", "--headless"],
    },
  },
  {
    id: "datadog",
    name: "Datadog",
    description:
      "Query Datadog logs, metrics, traces, monitors, dashboards and incidents (US1 site).",
    auth: "apiKey",
    requiredVars: [
      { name: "DD_API_KEY", description: "A Datadog API key." },
      {
        name: "DD_APPLICATION_KEY",
        description:
          "A Datadog application key; its scopes limit what the agent can read and change.",
      },
    ],
    mcp: {
      type: "remote",
      url: "https://mcp.datadoghq.com/v1/mcp",
      headers: {
        DD_API_KEY: "{env:DD_API_KEY}",
        DD_APPLICATION_KEY: "{env:DD_APPLICATION_KEY}",
      },
      oauth: false,
    },
  },
];

/** The env flag that adds {@link E2E_FAKE_CONNECTOR} to the catalog. */
export const E2E_FAKE_CONNECTOR_FLAG = "SCARN_E2E_FAKE_CONNECTOR";

/**
 * A test-only connector for `packages/e2e-tests`. It runs the fake MCP server
 * the e2e repository commits at `.scarn/e2e-fake-mcp.mjs`, and joins the
 * catalog only in a process started with `SCARN_E2E_FAKE_CONNECTOR=true`. The
 * e2e uses it through a named environment, which `scarn pipelines push`, the
 * server and the worker all validate, so each of them needs the flag.
 */
export const E2E_FAKE_CONNECTOR: ConnectorDefinition = {
  id: "e2e-fake",
  name: "E2E fake",
  description: "Test-only fake MCP server for the end-to-end tests.",
  auth: "apiKey",
  requiredVars: [
    {
      name: "FAKE_API_KEY",
      description: "Any value; the fake server needs one.",
    },
  ],
  mcp: {
    type: "local",
    command: ["bun", ".scarn/e2e-fake-mcp.mjs"],
    environment: { FAKE_API_KEY: "{env:FAKE_API_KEY}" },
  },
};

/** The catalog's entries, plus the e2e fake when `env` sets its flag. */
export function connectorDefinitions(
  env: Readonly<Record<string, string | undefined>>,
): readonly ConnectorDefinition[] {
  return env[E2E_FAKE_CONNECTOR_FLAG] === "true"
    ? [...CONNECTOR_DEFINITIONS, E2E_FAKE_CONNECTOR]
    : CONNECTOR_DEFINITIONS;
}

/** Returns every problem with a catalog; empty when it is valid. */
export function validateConnectorCatalog(
  entries: readonly ConnectorDefinition[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const label = `connector "${entry.id}"`;
    if (!CONNECTOR_ID_PATTERN.test(entry.id)) {
      problems.push(`${label}: id must be kebab-case`);
    }
    if (seen.has(entry.id)) problems.push(`${label}: duplicate id`);
    seen.add(entry.id);
    if (!openCodeResolvedMcpServerConfigSchema.safeParse(entry.mcp).success) {
      problems.push(`${label}: mcp is not a valid OpenCode MCP config`);
    }
    const credentialValues = Object.values(
      entry.mcp.type === "local"
        ? (entry.mcp.environment ?? {})
        : (entry.mcp.headers ?? {}),
    );
    if (!credentialValues.every(isEnvPlaceholderValue)) {
      problems.push(
        `${label}: ${entry.mcp.type === "local" ? "environment" : "headers"} values must be {env:NAME} placeholders`,
      );
    }
    const declared = entry.requiredVars.map((variable) => variable.name);
    if (new Set(declared).size !== declared.length) {
      problems.push(`${label}: requiredVars names must be unique`);
    }
    for (const name of declared) {
      if (!ENV_VAR_NAME_PATTERN.test(name)) {
        problems.push(`${label}: requiredVars "${name}" is not a valid name`);
      }
    }
    const read = collectEnvPlaceholderNames(entry.mcp);
    for (const name of read.filter((name) => !declared.includes(name))) {
      problems.push(
        `${label}: mcp reads {env:${name}} but requiredVars omits it`,
      );
    }
    for (const name of declared.filter((name) => !read.includes(name))) {
      problems.push(
        `${label}: requiredVars lists ${name} but mcp never reads it`,
      );
    }
    if ((entry.auth === "none") !== (declared.length === 0)) {
      problems.push(
        `${label}: auth "none" means no requiredVars, and requiredVars need an auth`,
      );
    }
  }
  return problems;
}

function buildCatalog(
  entries: readonly ConnectorDefinition[],
): Readonly<Record<string, ConnectorDefinition>> {
  const problems = validateConnectorCatalog(entries);
  if (problems.length > 0) {
    throw new Error(`Invalid connector catalog: ${problems.join("; ")}`);
  }
  return Object.freeze(
    Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  );
}

const runtimeEnv =
  (
    globalThis as {
      process?: { env?: Readonly<Record<string, string | undefined>> };
    }
  ).process?.env ?? {};

export const CONNECTOR_CATALOG = buildCatalog(connectorDefinitions(runtimeEnv));

export function isConnectorId(id: string): boolean {
  return Object.hasOwn(CONNECTOR_CATALOG, id);
}

export function getConnector(id: string): ConnectorDefinition | undefined {
  return isConnectorId(id) ? CONNECTOR_CATALOG[id] : undefined;
}

export function listConnectorSummaries(): ConnectorSummary[] {
  return Object.values(CONNECTOR_CATALOG).map(
    ({ id, name, description, auth, requiredVars }) => ({
      id,
      name,
      description,
      auth,
      requiredVars: requiredVars.map((variable) => ({ ...variable })),
    }),
  );
}
