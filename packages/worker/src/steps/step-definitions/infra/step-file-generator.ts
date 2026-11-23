import { parseSchema } from "json-schema-to-zod";
import { appliesToSetup, type EnvVarSpec } from "@scarn/sdk/env-vars";
import {
  Features,
  isSecretLookingEnvName,
  type AnyStepFeature,
  type Grant,
} from "@scarn/sdk/definitions/steps";
import { DEFAULT_CODE_STEP_RUNTIME_ID } from "@scarn/sdk/managed-runtimes";
import type { StepDefContract } from "./step-file-contract";
import { buildRepoProperty } from "./step-file-repo-source";
import { isValidIdentifier, templateToExpr } from "./step-file-template-source";
export type { StepDefContract } from "./step-file-contract";

export function keyToVarName(key: string): string {
  return key
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9_$]/g, "_");
}

const PROMPT_SCOPES = ["input", "env", "scarn"] as const;

export function promptToSource(prompt: string): string {
  const { expr, usedScopes } = templateToExpr(prompt, PROMPT_SCOPES);
  return usedScopes.length === 0
    ? expr
    : `({ ${usedScopes.join(", ")} }) => ${expr}`;
}

export function schemaToZodExpr(
  schemaJson: Record<string, unknown> | null,
): string {
  if (!schemaJson) return "z.unknown()";
  try {
    return parseSchema(schemaJson);
  } catch {
    return "z.unknown()";
  }
}

type EnvEntrySource = {
  expr: string;
  usesInput: boolean;
  usesEnvHelper: boolean;
};

/**
 * Renders one `envJson` entry the way `defineStep` accepts it back: a bare
 * string for a plain value, `Env.value` for a secret (or for a static value on
 * a secret-looking name, which `defineStep` would otherwise reject), and
 * `Env.inherit` for a worker-sourced variable with only its non-default
 * options spelled out, and `Env.secret` for a project secret.
 */
function envEntryToSource(entry: EnvVarSpec): EnvEntrySource {
  const appliesOpts = appliesToSetup(entry.applies)
    ? [`applies: ${JSON.stringify(entry.applies)}`]
    : [];
  if (entry.source === "inherit") {
    const opts: string[] = [];
    if (entry.from !== entry.name) {
      opts.push(`from: ${JSON.stringify(entry.from)}`);
    }
    if (entry.secret) opts.push("secret: true");
    if (entry.optional) opts.push("optional: true");
    if (entry.default !== undefined) {
      opts.push(`default: ${JSON.stringify(entry.default)}`);
    }
    opts.push(...appliesOpts);
    return {
      expr: `Env.inherit(${opts.length > 0 ? `{ ${opts.join(", ")} }` : ""})`,
      usesInput: false,
      usesEnvHelper: true,
    };
  }
  if (entry.source === "secret") {
    const args = [
      JSON.stringify(entry.secretName),
      ...(appliesOpts.length > 0 ? [`{ ${appliesOpts.join(", ")} }`] : []),
    ];
    return {
      expr: `Env.secret(${args.join(", ")})`,
      usesInput: false,
      usesEnvHelper: true,
    };
  }

  const { expr, usedScopes } = templateToExpr(entry.value, ["input"]);
  const usesInput = usedScopes.length > 0;
  const valueOpts = (extra: string[]) =>
    `Env.value({ ${[`value: ${expr}`, ...extra, ...appliesOpts].join(", ")} })`;
  if (entry.secret) {
    return {
      expr: valueOpts(["secret: true"]),
      usesInput,
      usesEnvHelper: true,
    };
  }
  if (!usesInput && isSecretLookingEnvName(entry.name)) {
    return {
      expr: valueOpts(["unsafeAllowStatic: true"]),
      usesInput,
      usesEnvHelper: true,
    };
  }
  if (appliesOpts.length > 0) {
    return { expr: valueOpts([]), usesInput, usesEnvHelper: true };
  }
  return { expr, usesInput, usesEnvHelper: false };
}

/**
 * The `vars: ({ input }) => ({ ... })` property lines for a step's
 * `environment`, or null when it declares none. `input` is destructured only
 * when a template reads it.
 */
function buildVarsProperty(
  envJson: EnvVarSpec[] | null | undefined,
): { property: string; usesEnvHelper: boolean } | null {
  if (!envJson || envJson.length === 0) return null;

  const entries = envJson.map((entry) => ({
    name: entry.name,
    ...envEntryToSource(entry),
  }));
  const params = entries.some((entry) => entry.usesInput) ? "{ input }" : "";
  const lines = entries.map(
    (entry) =>
      `      ${isValidIdentifier(entry.name) ? entry.name : JSON.stringify(entry.name)}: ${entry.expr},`,
  );
  return {
    property: `    vars: (${params}) => ({\n${lines.join("\n")}\n    }),`,
    usesEnvHelper: entries.some((entry) => entry.usesEnvHelper),
  };
}

/**
 * The runtime property for a step's `environment`, or null for the default
 * (an agent step with no selected config, or a code step on the default
 * managed runtime). The host runtime carries no config
 * path.
 *
 * Explicit pathless devcontainer stays distinct from repository default.
 */
function buildRuntimeProperty(step: StepDefContract): string | null {
  const runtime =
    step.environment?.kind === "inline" ? step.environment.runtime : undefined;
  if (runtime?.kind === "host") {
    return "    runtime: Runtime.host(),";
  }
  if (runtime?.kind === "managed") {
    if (step.kind === "code" && runtime.id === DEFAULT_CODE_STEP_RUNTIME_ID) {
      return null;
    }
    const factory = isValidIdentifier(runtime.id)
      ? `.${runtime.id}`
      : `[${JSON.stringify(runtime.id)}]`;
    return `    runtime: Runtime.managed${factory}(),`;
  }
  if (runtime?.kind === "devcontainer" && runtime.config) {
    return `    runtime: Runtime.devcontainer({ config: ${JSON.stringify(runtime.config)} }),`;
  }
  return runtime?.kind === "devcontainer"
    ? "    runtime: Runtime.devcontainer(),"
    : null;
}

type EnvironmentField = {
  field: string;
  usesEnvHelper: boolean;
  usesRuntimeHelper: boolean;
};

/**
 * The `environment: { runtime, vars, connectors }` field for a step, or null when it
 * declares none. It precedes `agentPrompt` so `vars` keys are inferred into
 * the prompt's `env`.
 */
function buildEnvironmentField(step: StepDefContract): EnvironmentField | null {
  if (step.environment?.kind === "named") {
    throw new Error("Named environment source generation is not supported yet");
  }
  if (step.environment === null) {
    if (step.kind === "code") {
      throw new Error(
        `Code step "${step.key}" uses repository-default environment; source generation requires SDK support for explicit null environments`,
      );
    }
    return null;
  }
  const runtime = buildRuntimeProperty(step);
  const vars = buildVarsProperty(step.environment.envJson);
  const connectors =
    step.environment.connectors === undefined ||
    step.environment.connectors.length === 0
      ? null
      : `    connectors: ${JSON.stringify(step.environment.connectors)},`;
  const properties = [runtime, vars?.property, connectors].filter(
    (property): property is string =>
      property !== null && property !== undefined,
  );

  return {
    field: `  environment: {\n${properties.join("\n")}\n  }`,
    usesEnvHelper: vars?.usesEnvHelper ?? false,
    usesRuntimeHelper: runtime !== null,
  };
}

function grantToFeature(grant: Grant): {
  feature: AnyStepFeature;
  source: string;
} {
  const { workItems } = Features;
  switch (grant.action) {
    case "label":
      return {
        feature: workItems.label({
          scope: grant.scope,
          labels: grant.labels as [string, ...string[]],
        }),
        source: `Features.workItems.label({ scope: ${JSON.stringify(grant.scope)}, labels: ${JSON.stringify(grant.labels)} })`,
      };
    case "create":
      return {
        feature: workItems.create({
          scope: grant.scope,
          labels: grant.labels as [string, ...string[]],
        }),
        source: `Features.workItems.create({ scope: ${JSON.stringify(grant.scope)}, labels: ${JSON.stringify(grant.labels)} })`,
      };
    case "read":
      return {
        feature: workItems.read({ scope: grant.scope }),
        source: `Features.workItems.read({ scope: ${JSON.stringify(grant.scope)} })`,
      };
    default:
      return {
        feature: workItems[grant.action]({ scope: grant.scope }),
        source: `Features.workItems.${grant.action}({ scope: ${JSON.stringify(grant.scope)} })`,
      };
  }
}

/**
 * The `features: [...]` sources for a step's grants, and its prompt with the
 * sections those features append taken back off, so a pulled file compiles
 * back to the same prompt.
 */
function buildGrantFeatures(step: StepDefContract): {
  prompt: string;
  sources: string[];
} {
  const prompt = step.prompt ?? "";
  const grants = step.grants ?? [];
  if (grants.length === 0) return { prompt, sources: [] };

  const features = grants.map(grantToFeature);
  const additions = features.map(({ feature }) => feature._promptAddition);
  const suffix = additions.map((addition) => `\n\n${addition}`).join("");
  const sources = features.map(({ source }) => source);
  if (prompt.endsWith(suffix)) {
    return { prompt: prompt.slice(0, -suffix.length), sources };
  }
  if (prompt === additions.join("\n\n")) return { prompt: "", sources };
  return { prompt, sources };
}

export function generateStepsFileContent(steps: StepDefContract[]): string {
  if (steps.length === 0) return "";

  const environmentFields = steps.map(buildEnvironmentField);
  const usesEnvHelper = environmentFields.some((field) => field?.usesEnvHelper);
  const usesRuntimeHelper = environmentFields.some(
    (field) => field?.usesRuntimeHelper,
  );
  const repoFields = steps.map(buildRepoProperty);
  const usesRepoHelper = repoFields.some((field) => field !== null);
  const usesWorkBranchHelper = repoFields.some((field) =>
    field?.includes("WorkBranch."),
  );
  const grantFeatures = steps.map(buildGrantFeatures);
  const usesFeatures = grantFeatures.some(({ sources }) => sources.length > 0);
  const stepBlocks = steps.map((step, index) => {
    const varName = keyToVarName(step.key);
    const inputExpr = schemaToZodExpr(step.inputSchemaJson);
    const resultExpr = schemaToZodExpr(step.resultSchemaJson);

    const fields: string[] = [
      `  key: ${JSON.stringify(step.key)}`,
      `  name: ${JSON.stringify(step.name)}`,
      `  version: ${String(step.version)}`,
      `  status: ${JSON.stringify(step.status)} as const`,
    ];
    if (step.description)
      fields.push(`  description: ${JSON.stringify(step.description)}`);
    const environmentField = environmentFields[index];
    if (environmentField) fields.push(environmentField.field);
    const repoField = repoFields[index];
    if (repoField) fields.push(repoField);
    const { prompt, sources: featureSources } = grantFeatures[index] ?? {
      prompt: step.prompt ?? "",
      sources: [],
    };
    fields.push(`  agentPrompt: ${promptToSource(prompt)}`);
    fields.push(`  input: ${inputExpr}`);
    fields.push(`  result: ${resultExpr}`);
    if (step.opencodeMcpJson && Object.keys(step.opencodeMcpJson).length > 0) {
      const mcpJson = JSON.stringify(step.opencodeMcpJson, null, 2).replace(
        /\n/g,
        "\n  ",
      );
      fields.push(`  mcpServers: ${mcpJson}`);
    }
    if (step.healthChecksJson && step.healthChecksJson.length > 0) {
      const healthChecksJson = JSON.stringify(
        step.healthChecksJson,
        null,
        2,
      ).replace(/\n/g, "\n  ");
      fields.push(`  healthChecks: ${healthChecksJson}`);
    }
    if (step.errors && step.errors.length > 0) {
      fields.push(`  errors: ${JSON.stringify(step.errors)}`);
    }
    if (step.retry && step.retry.length > 0) {
      const entries = step.retry.map(
        (entry) =>
          `{ on: ${JSON.stringify(entry.on)}, maxAttempts: ${String(entry.maxAttempts)} }`,
      );
      fields.push(`  retry: [${entries.join(", ")}]`);
    }
    if (step.maxTurns != null) {
      fields.push(`  maxTurns: ${String(step.maxTurns)}`);
    }
    if (featureSources.length > 0) {
      fields.push(
        `  features: [\n${featureSources.map((source) => `    ${source},`).join("\n")}\n  ]`,
      );
    }

    return `export const ${varName} = defineStep({\n${fields.join(",\n")},\n});`;
  });

  const sdkImports = [
    "defineStep",
    ...(usesRuntimeHelper ? ["Runtime"] : []),
    ...(usesRepoHelper ? ["Repo"] : []),
    ...(usesWorkBranchHelper ? ["WorkBranch"] : []),
    ...(usesEnvHelper ? ["Env"] : []),
    ...(usesFeatures ? ["Features"] : []),
  ].join(", ");
  return `import { z } from "zod";
import { ${sdkImports} } from "@scarn/sdk/definitions/steps";

${stepBlocks.join("\n\n")}
`;
}
