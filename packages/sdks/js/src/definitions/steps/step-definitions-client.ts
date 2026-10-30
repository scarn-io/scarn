import { createClient } from "../../generated/client";
import { StepDefinitions } from "../../generated/sdk.gen";
import type {
  PostApiStepDefinitionsData,
  PutApiStepDefinitionsData,
} from "../../generated/types.gen";
import type { StepDefinitionSpec } from "./define-step";
import { toStepSpec } from "./step-handle";

type RequestOptions = {
  headers?: Record<string, unknown> | undefined;
};

export type CreateStepDefinitionInput = PostApiStepDefinitionsData["body"];
export type UpsertStepDefinitionInput = PutApiStepDefinitionsData["body"];

/**
 * What a step without an `additionalInput` schema accepts, and what a code
 * step without a `resultSchema` returns. An agent step without a `result` is
 * sent with a null result schema: a conversation step.
 */
const ANY_OBJECT_SCHEMA = { type: "object" };

export function createStepDefinitionsClient(
  baseUrl: string,
): ReturnType<typeof buildStepDefinitionsClient> {
  const client = createClient({ baseUrl });
  return buildStepDefinitionsClient(new StepDefinitions({ client }));
}

const buildStepDefinitionsClient = (stepDefinitions: StepDefinitions) => {
  return {
    listByProjectId: async (projectId: string, options?: RequestOptions) => {
      const result = await stepDefinitions.listStepDefinitions({
        query: { projectId },
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    create: async (
      body: CreateStepDefinitionInput,
      options?: RequestOptions,
    ) => {
      const result = await stepDefinitions.createStepDefinition({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
    /**
     * Upserts a step definition keyed by (projectId, key, version). Accepts a
     * step handle from `defineStep()`/`codeStep()` or a plain spec directly —
     * no separate fetch-existing/branch-on-id step needed.
     *
     * The request body is built field by field so the spec's transient
     * `entrypoint.fn` (a live, unserializable function reference — present
     * only if a caller bypasses `collect-definitions.ts`'s own strip step)
     * is never included.
     */
    upsertFromSpec: async (
      projectId: string,
      step: StepDefinitionSpec,
      options?: RequestOptions,
    ) => {
      const spec = toStepSpec(step);
      const body: UpsertStepDefinitionInput = {
        key: spec.key,
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt ?? null,
        version: spec.version,
        kind: spec.kind,
        entrypointJson: spec.entrypointJson ?? null,
        executionMode: spec.executionMode,
        devcontainerConfigPath: spec.devcontainerConfigPath,
        managedRuntime: spec.managedRuntime,
        repo: spec.repo,
        inputSchemaJson: spec.inputSchemaJson ?? ANY_OBJECT_SCHEMA,
        resultSchemaJson:
          spec.kind === "code"
            ? (spec.resultSchemaJson ?? ANY_OBJECT_SCHEMA)
            : spec.resultSchemaJson,
        opencodeMcpJson: spec.opencodeMcpJson,
        healthChecksJson: spec.healthChecksJson,
        envJson: spec.envJson,
        errors: [...(spec.errors ?? [])],
        retry: (spec.retryJson ?? []).map((entry) => ({
          on: [...entry.on],
          maxAttempts: entry.maxAttempts,
        })),
        status: spec.status,
        projectId,
      };
      const result = await stepDefinitions.upsertStepDefinition({
        body,
        headers: options?.headers,
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.data;
    },
  };
};
