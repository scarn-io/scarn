/**
 * Pure logic behind the start dialog's environment and connector fields:
 * which connectors a Task already has and where they come from, which vars an
 * extra connector still needs, the `environment` part of the
 * `POST /api/tasks` body, and where a 422 from that route belongs.
 */
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import type { TaskEnvironmentInput } from "@scarn/core/tasks/task/contracts/task-environment-selection-contracts";
import { ENV_VAR_NAME_PATTERN } from "@scarn/sdk/env-vars";
import {
  apiErrorCode,
  apiErrorMeta,
  parseApiError,
} from "@/app/_lib/api-error";

export type StartTaskMode = "step" | "prompt";

export type StartTaskStep = Pick<
  StepDefinitionContract,
  "environment" | "opencodeMcpJson"
>;

/** The parts of an environment's content the dialog reads. */
export type EnvironmentFacts = {
  connectors?: readonly string[] | null;
  vars?: readonly { name: string; applies?: string }[] | null;
};

export type CatalogConnector = {
  id: string;
  name: string;
  requiredVars: readonly { name: string; description: string }[];
};

export type LockedConnector = { id: string; note: string };

/** Var name → typed secret name, per extra connector id. */
export type ExtraVarDrafts = Record<string, Record<string, string>>;

export const environmentDefaultLabel = (mode: StartTaskMode): string =>
  mode === "step" ? "Step default" : "Repo default";

/** An inline step environment is pinned by its author and can't be replaced. */
export const isEnvironmentLocked = (
  mode: StartTaskMode,
  step: StartTaskStep | null,
): boolean => mode === "step" && step?.environment?.kind === "inline";

/** The named environment the Task will run in, when there is one. */
export const effectiveEnvironmentName = (
  mode: StartTaskMode,
  step: StartTaskStep | null,
  override: string,
): string | null => {
  if (override && !isEnvironmentLocked(mode, step)) return override;
  if (mode === "step" && step?.environment?.kind === "named") {
    return step.environment.name;
  }
  return null;
};

/**
 * The effective environment's content: the loaded named one, the step's
 * inline one, or nothing for the repo default.
 */
export const effectiveEnvironmentFacts = (
  mode: StartTaskMode,
  step: StartTaskStep | null,
  override: string,
  named: EnvironmentFacts | null,
): EnvironmentFacts | null => {
  if (effectiveEnvironmentName(mode, step, override) !== null) return named;
  if (mode === "step" && step?.environment?.kind === "inline") {
    return {
      connectors: step.environment.connectors ?? [],
      vars: step.environment.envJson ?? [],
    };
  }
  return null;
};

const stepMcpKeys = (
  mode: StartTaskMode,
  step: StartTaskStep | null,
): string[] =>
  mode === "step" && step?.opencodeMcpJson
    ? Object.keys(step.opencodeMcpJson)
    : [];

/** Connectors the Task already has, each with where it comes from. */
export const lockedConnectors = ({
  mode,
  step,
  override,
  environment,
}: {
  mode: StartTaskMode;
  step: StartTaskStep | null;
  override: string;
  environment: EnvironmentFacts | null;
}): LockedConnector[] => {
  const name = effectiveEnvironmentName(mode, step, override);
  const environmentNote =
    name === null
      ? "From the step's environment"
      : `From environment "${name}"`;
  const locked = new Map<string, string>();
  for (const id of environment?.connectors ?? []) {
    locked.set(id, environmentNote);
  }
  for (const key of stepMcpKeys(mode, step)) {
    if (!locked.has(key)) locked.set(key, "From the step's MCP servers");
  }
  return [...locked].map(([id, note]) => ({ id, note }));
};

/** Var names the environment gives the agent; a setup-only var doesn't count. */
const providedVarNames = (environment: EnvironmentFacts | null): Set<string> =>
  new Set(
    (environment?.vars ?? [])
      .filter((entry) => entry.applies !== "setup")
      .map((entry) => entry.name),
  );

/** The connector's required vars the environment doesn't provide. */
export const varsToName = (
  connector: CatalogConnector | undefined,
  environment: EnvironmentFacts | null,
): string[] => {
  const provided = providedVarNames(environment);
  return (connector?.requiredVars ?? [])
    .map((variable) => variable.name)
    .filter((name) => !provided.has(name));
};

/** The secret named for `varName`: what was typed, else a saved secret of the same name. */
export const secretNameFor = (
  drafts: ExtraVarDrafts,
  connectorId: string,
  varName: string,
  savedSecretNames: readonly string[],
): string =>
  drafts[connectorId]?.[varName] ??
  (savedSecretNames.includes(varName) ? varName : "");

export type SecretNameStatus = "missing" | "invalid" | "saved" | "worker";

export const secretNameStatus = (
  secretName: string,
  savedSecretNames: readonly string[],
): SecretNameStatus => {
  const trimmed = secretName.trim();
  if (!trimmed) return "missing";
  if (!ENV_VAR_NAME_PATTERN.test(trimmed)) return "invalid";
  return savedSecretNames.includes(trimmed) ? "saved" : "worker";
};

/** Extras that aren't already locked in by the environment or the step. */
export const activeExtras = (
  extras: readonly string[],
  locked: readonly LockedConnector[],
): string[] => {
  const lockedIds = new Set(locked.map((connector) => connector.id));
  return extras.filter((id) => !lockedIds.has(id));
};

/**
 * The `environment` body field; `undefined` when nothing is chosen, `null`
 * while a required var has no valid secret name.
 */
export const buildEnvironmentInput = ({
  override,
  extras,
  catalog,
  environment,
  drafts,
  savedSecretNames,
}: {
  override: string;
  extras: readonly string[];
  catalog: readonly CatalogConnector[];
  environment: EnvironmentFacts | null;
  drafts: ExtraVarDrafts;
  savedSecretNames: readonly string[];
}): TaskEnvironmentInput | undefined | null => {
  const extraConnectors: NonNullable<TaskEnvironmentInput["extraConnectors"]> =
    [];
  for (const connectorId of extras) {
    const connector = catalog.find((entry) => entry.id === connectorId);
    const vars: Record<string, { secret: string }> = {};
    for (const varName of varsToName(connector, environment)) {
      const secret = secretNameFor(
        drafts,
        connectorId,
        varName,
        savedSecretNames,
      ).trim();
      const status = secretNameStatus(secret, savedSecretNames);
      if (status === "missing" || status === "invalid") return null;
      vars[varName] = { secret };
    }
    extraConnectors.push({ connectorId, vars });
  }
  if (!override && extraConnectors.length === 0) return undefined;
  return {
    ...(override ? { name: override } : {}),
    ...(extraConnectors.length > 0 ? { extraConnectors } : {}),
  };
};

export type StartTaskErrors = {
  environment?: string;
  connectors?: string;
  /** connector id → var name → message */
  vars?: Record<string, Record<string, string>>;
  general?: string;
};

const ENVIRONMENT_CODES = new Set([
  "ENVIRONMENT_OVERRIDE_INLINE",
  "ENVIRONMENT_NOT_FOUND",
  "ENVIRONMENT_OVERRIDE_INCOMPATIBLE",
]);

const CONNECTOR_CODES = new Set([
  "CONNECTOR_NOT_FOUND",
  "CONNECTOR_ALREADY_PRESENT",
]);

const FALLBACK = "Couldn't start the task.";

/** Places a failed `POST /api/tasks` next to the field it's about. */
export const mapStartTaskError = (
  // eslint-disable-next-line local/no-unknown-parameter-type -- a thrown API error has no static shape
  error: unknown,
): StartTaskErrors => {
  const code = apiErrorCode(error);
  const message = parseApiError(error, FALLBACK);
  if (code !== undefined && ENVIRONMENT_CODES.has(code)) {
    return { environment: message };
  }
  if (code !== undefined && CONNECTOR_CODES.has(code)) {
    return { connectors: message };
  }
  if (code === "CONNECTOR_VAR_MISSING") {
    const meta = apiErrorMeta(error);
    const connectorId = meta?.["connectorId"];
    const vars = meta?.["vars"];
    if (typeof connectorId === "string" && Array.isArray(vars)) {
      return {
        vars: {
          [connectorId]: Object.fromEntries(
            vars
              .filter((name): name is string => typeof name === "string")
              .map((name) => [name, "Name a project secret for this var."]),
          ),
        },
      };
    }
  }
  return { general: message };
};
