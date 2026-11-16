import type { EnvVarSpec } from "@scarn/sdk/env-vars";

/**
 * Resolves the project secrets an environment's `secret` vars name (plan
 * decisions 3 and 4). The worker's `.scarn/.env`, keyed by the secret name,
 * wins; the remaining names are requested from Scarn in one call, made only
 * when `.scarn/.env` lacks some name. `process.env` is never consulted.
 *
 * Names neither source has are left out of `values`; {@link resolveStepEnv}
 * reports them with every other missing variable. Values live only in the
 * returned object, for this run.
 */

export type SecretValueSource = "worker" | "scarn";

/** The Scarn side of the lookup: `POST /task-runs/:taskRunId/environment`. */
export type RequestProjectSecrets = (
  secretNames: readonly string[],
) => Promise<{
  secrets: Readonly<Record<string, { value: string }>>;
  missing: readonly string[];
}>;

export type ResolvedSecretEnv = {
  /** Secret name → value, for every name found. */
  values: Record<string, string>;
  /** Secret name → where its value came from. */
  sources: Record<string, SecretValueSource>;
};

/** A project-secret request to Scarn failed; the run cannot start. */
export class ProjectSecretsRequestError extends Error {
  readonly secretNames: readonly string[];

  constructor(secretNames: readonly string[], options: { cause: unknown }) {
    const reason =
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause);
    super(
      `Could not fetch project secrets ${secretNames.join(", ")} from Scarn: ${reason}. ` +
        "Set them in .scarn/.env or retry once Scarn is reachable.",
      options,
    );
    this.name = "ProjectSecretsRequestError";
    this.secretNames = secretNames;
  }
}

export function secretNamesOf(
  envVars: readonly EnvVarSpec[] | null | undefined,
): string[] {
  return [
    ...new Set(
      (envVars ?? []).flatMap((entry) =>
        entry.source === "secret" ? [entry.secretName] : [],
      ),
    ),
  ];
}

/** Splits secret names into those `.scarn/.env` holds and those to request. */
export function partitionSecretNames(
  envVars: readonly EnvVarSpec[] | null | undefined,
  localEnvVars: Readonly<Record<string, string>> | undefined,
): { fromWorker: Record<string, string>; toRequest: string[] } {
  const fromWorker: Record<string, string> = {};
  const toRequest: string[] = [];
  for (const name of secretNamesOf(envVars)) {
    const value = localEnvVars?.[name];
    if (value === undefined) toRequest.push(name);
    else fromWorker[name] = value;
  }
  return { fromWorker, toRequest };
}

export async function resolveSecretEnv(input: {
  envVars: readonly EnvVarSpec[] | null | undefined;
  localEnvVars: Readonly<Record<string, string>> | undefined;
  requestSecrets: RequestProjectSecrets;
}): Promise<ResolvedSecretEnv> {
  const { fromWorker, toRequest } = partitionSecretNames(
    input.envVars,
    input.localEnvVars,
  );
  const values: Record<string, string> = { ...fromWorker };
  const sources: Record<string, SecretValueSource> = {};
  for (const name of Object.keys(fromWorker)) sources[name] = "worker";
  if (toRequest.length === 0) return { values, sources };

  const response = await input.requestSecrets(toRequest);
  for (const name of toRequest) {
    const secret = response.secrets[name];
    if (secret === undefined) continue;
    values[name] = secret.value;
    sources[name] = "scarn";
  }
  return { values, sources };
}

/** A dry run's view of one `secret` var: where its value would come from. */
export type DryRunSecretReport = {
  name: string;
  secretName: string;
  /** `scarn`: not in `.scarn/.env`, so a real run will request it from Scarn. */
  source: SecretValueSource;
};

/**
 * Dry runs never fetch values from Scarn. Names `.scarn/.env` holds resolve
 * as in a real run; the rest are reported as "will request from Scarn" and
 * launch with an empty placeholder so the rehearsal still starts.
 */
export function planDryRunSecretEnv(
  envVars: readonly EnvVarSpec[] | null | undefined,
  localEnvVars: Readonly<Record<string, string>> | undefined,
): { values: Record<string, string>; secrets: DryRunSecretReport[] } {
  const { fromWorker, toRequest } = partitionSecretNames(envVars, localEnvVars);
  const values: Record<string, string> = { ...fromWorker };
  for (const name of toRequest) values[name] = "";
  const secrets = (envVars ?? []).flatMap((entry) =>
    entry.source === "secret"
      ? [
          {
            name: entry.name,
            secretName: entry.secretName,
            source:
              fromWorker[entry.secretName] === undefined
                ? ("scarn" as const)
                : ("worker" as const),
          },
        ]
      : [],
  );
  return { values, secrets };
}
