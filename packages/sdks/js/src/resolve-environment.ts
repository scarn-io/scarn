import { z } from "zod";
import {
  BrokenDevcontainerReference,
  EnvironmentInvalid,
  EnvironmentNotFound,
  environmentNameSchema,
  inlineEnvironmentReadSchema,
  type EnvironmentError,
  type EnvironmentRefRead,
  type ResolvedEnvironment,
  type ResolvedEnvironmentRefInput,
} from "./environment";
import { ConnectorVarsMissing, findMissingConnectorVars } from "./connectors";

const DEVCONTAINER_DISCOVERY_PATHS = [
  ".devcontainer/devcontainer.json",
  "devcontainer.json",
] as const;

export type ResolveEnvironmentDeps = {
  devcontainerExists(path: string): Promise<boolean>;
};

export type EnvironmentDefinition = Omit<ResolvedEnvironment, "runtime"> & {
  runtime?: Exclude<EnvironmentRefRead, null | { kind: "named" }>["runtime"];
};

type NamedEnvironmentContent = Extract<
  ResolvedEnvironmentRefInput,
  { content: unknown }
>["content"];

const namedContentAsInline = ({
  runtime,
  vars,
  connectors,
}: NamedEnvironmentContent) => ({
  kind: "inline" as const,
  ...(runtime === undefined ? {} : { runtime }),
  ...(vars === undefined ? {} : { envJson: vars }),
  ...(connectors === undefined ? {} : { connectors }),
});

const namedEnvironmentEnvelopeSchema = z.union([
  z.object({
    name: environmentNameSchema,
    version: z.number().int().positive(),
    content: z.object({}),
  }),
  z.object({ name: environmentNameSchema, notFound: z.literal(true) }),
]);

/**
 * Validates a run's environment without inspecting the checked-out runtime
 * files. A named environment's pinned content goes through the same checks
 * as an inline environment.
 */
export function readEnvironmentDefinition(
  ref: ResolvedEnvironmentRefInput,
): EnvironmentDefinition | EnvironmentError {
  let named: { name: string; label: string } | undefined;
  if (ref?.kind === "named") {
    const envelope = namedEnvironmentEnvelopeSchema.safeParse(ref);
    if (!envelope.success) {
      return new EnvironmentInvalid(undefined, envelope.error.issues);
    }
    if ("notFound" in envelope.data) {
      return new EnvironmentNotFound(envelope.data.name);
    }
    named = {
      name: envelope.data.name,
      label: `environment ${envelope.data.name} v${String(envelope.data.version)}`,
    };
  }
  const parsedRef = inlineEnvironmentReadSchema.safeParse(
    ref?.kind === "named" && "content" in ref
      ? namedContentAsInline(ref.content)
      : ref,
  );
  if (!parsedRef.success) {
    return new EnvironmentInvalid(
      named?.label,
      named === undefined
        ? parsedRef.error.issues
        : parsedRef.error.issues.map((issue) => ({
            ...issue,
            path: issue.path.map((key) => (key === "envJson" ? "vars" : key)),
          })),
    );
  }
  const reference = parsedRef.data;
  const runtime = reference?.runtime;
  const envVars = reference?.envJson ?? [];
  const connectors = reference?.connectors ?? [];
  const missing = findMissingConnectorVars(connectors, envVars);
  if (missing.length > 0) {
    return new ConnectorVarsMissing(named?.label, missing);
  }

  return {
    source: named ? "named" : (reference?.kind ?? "repo-default"),
    ...(named ? { name: named.name } : {}),
    ...(runtime === undefined ? {} : { runtime }),
    envVars,
    connectors,
  };
}

/** Resolves a run's environment, inspecting runtime files in the checkout. Dependency I/O failures propagate. */
export async function resolveEnvironment(
  deps: ResolveEnvironmentDeps,
  ref: ResolvedEnvironmentRefInput,
): Promise<ResolvedEnvironment | EnvironmentError> {
  const definition = readEnvironmentDefinition(ref);
  if (definition instanceof Error) return definition;
  return resolveEnvironmentDefinition(deps, definition);
}

/** Resolves runtime files only after the caller has selected the code checkout. */
export async function resolveEnvironmentDefinition(
  deps: Pick<ResolveEnvironmentDeps, "devcontainerExists">,
  definition: EnvironmentDefinition,
): Promise<ResolvedEnvironment | EnvironmentError> {
  const { runtime } = definition;
  let resolvedRuntime: ResolvedEnvironment["runtime"];
  if (runtime?.kind === "devcontainer" && runtime.config !== undefined) {
    if (!(await deps.devcontainerExists(runtime.config))) {
      return new BrokenDevcontainerReference(runtime.config);
    }
    resolvedRuntime = { kind: "devcontainer", config: runtime.config };
  } else if (runtime === undefined || runtime.kind === "devcontainer") {
    let discoveredConfig: string | undefined;
    for (const config of DEVCONTAINER_DISCOVERY_PATHS) {
      if (await deps.devcontainerExists(config)) {
        discoveredConfig = config;
        break;
      }
    }
    if (discoveredConfig !== undefined) {
      resolvedRuntime = { kind: "devcontainer", config: discoveredConfig };
    } else if (runtime?.kind === "devcontainer") {
      return new BrokenDevcontainerReference(
        DEVCONTAINER_DISCOVERY_PATHS[0],
        DEVCONTAINER_DISCOVERY_PATHS,
      );
    } else {
      resolvedRuntime = { kind: "managed", id: "bun1" };
    }
  } else {
    resolvedRuntime = runtime;
  }
  return {
    ...definition,
    runtime: resolvedRuntime,
  };
}
