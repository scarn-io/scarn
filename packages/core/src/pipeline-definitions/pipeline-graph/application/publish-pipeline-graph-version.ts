import { createHash } from "node:crypto";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { canonicalJson } from "@scarn/core/lib/canonical-json";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import {
  pipelineDocumentSchema,
  type PipelineDocument,
  type StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  formatValidationError,
  validatePipeline,
} from "@scarn/shared-core/pipelines";
import {
  publishPipelineVersionInputSchema,
  type PublishPipelineVersionInput,
  type PublishPipelineVersionResult,
} from "../contracts/pipeline-graph-contracts";
import { CURRENT_PIPELINE_GRAPH_VERSION_SCHEMA_VERSION } from "../contracts/pipeline-graph-version-stored";
import type { PipelineGraphEntity } from "../domain/pipeline-graph-entity";
import {
  PipelineGraphVersionEntity,
  type PinnedStep,
} from "../domain/pipeline-graph-version-entity";
import type { PipelineGraphRepo } from "./pipeline-graph-repo";
import type { PipelineGraphVersionRepo } from "./pipeline-graph-version-repo";
import {
  pipelineGraphEntityToContract,
  pipelineGraphVersionEntityToContract,
} from "./pipeline-graph-contract-mapper";

export type PublishPipelineGraphVersionDeps = {
  pipelineGraphRepo: PipelineGraphRepo;
  pipelineGraphVersionRepo: PipelineGraphVersionRepo;
  stepDefinitionRepo: StepDefinitionRepo;
  timeProvider: TimeProvider;
};

const stepKeysOf = (document: AnyJsonObject): string[] => {
  const parsed = pipelineDocumentSchema.safeParse(document);
  if (!parsed.success) {
    return [];
  }
  const keys = Object.values(parsed.data.nodes).flatMap((node) =>
    node.kind === "step" ? [node.step] : [],
  );
  return [...new Set(keys)];
};

/** sha256 of the canonical document plus the pinned step versions. */
export const hashPipelineVersion = (
  document: PipelineDocument,
  steps: readonly PinnedStep[],
): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        document,
        steps: [...steps]
          .sort((left, right) => left.stepKey.localeCompare(right.stepKey))
          .map((step) => ({
            stepKey: step.stepKey,
            stepDefinitionId: step.stepDefinitionId,
          })),
      }),
    )
    .digest("hex");

/**
 * Validates `document` against the latest active version of every step it
 * uses, pins those versions, and stores it as the pipeline's next version,
 * which becomes the active one. When the content hash matches the latest
 * version, nothing is written and that version is returned. Must run inside
 * the caller's transaction.
 */
export const publishPipelineGraphVersion = async (
  handle: PipelineGraphEntity,
  document: AnyJsonObject,
  deps: PublishPipelineGraphVersionDeps,
  tx: DbExecutor,
): Promise<
  Result<
    {
      published: boolean;
      handle: PipelineGraphEntity;
      version: PipelineGraphVersionEntity;
    },
    CoreValidationError
  >
> => {
  const stepDefinitions = await deps.stepDefinitionRepo.listLatestActiveByKeys(
    handle.projectId,
    stepKeysOf(document),
    tx,
  );
  const catalog: StepCatalog = Object.fromEntries(
    stepDefinitions.map((step) => [
      step.key,
      {
        inputSchema: step.inputSchemaJson,
        resultSchema: step.resultSchemaJson,
        errors: step.errors,
      },
    ]),
  );

  const validation = validatePipeline(document, catalog);
  if (!validation.ok) {
    return Result.err(
      new CoreValidationError(
        `Pipeline document is invalid:\n${validation.errors.map(formatValidationError).join("\n")}`,
        "PIPELINE_DOCUMENT_INVALID",
        { errors: validation.errors },
      ),
    );
  }
  const validDocument = validation.document;
  if (validDocument.key !== handle.key) {
    return Result.err(
      new CoreValidationError(
        `Pipeline document key '${validDocument.key}' does not match pipeline '${handle.key}'`,
        "PIPELINE_DOCUMENT_KEY_MISMATCH",
      ),
    );
  }

  const steps: PinnedStep[] = stepDefinitions.map((step) => ({
    stepKey: step.key,
    stepDefinitionId: step.id,
  }));
  const contentHash = hashPipelineVersion(validDocument, steps);
  const latest = await deps.pipelineGraphVersionRepo.loadLatestByGraphId(
    handle.id,
    tx,
  );
  if (latest?.contentHash === contentHash) {
    return Result.ok({ published: false, handle, version: latest });
  }

  const now = deps.timeProvider.now();
  const version = await deps.pipelineGraphVersionRepo.insert(
    PipelineGraphVersionEntity.create({
      pipelineGraphId: handle.id,
      version: (latest?.version ?? 0) + 1,
      definitionJson: validDocument,
      schemaVersion: CURRENT_PIPELINE_GRAPH_VERSION_SCHEMA_VERSION,
      contentHash,
      steps,
      createdAt: now,
    }),
    tx,
  );
  const updatedHandle = await deps.pipelineGraphRepo.updateHandle(
    handle.withCurrentVersionId(version.id, now),
    tx,
  );
  return Result.ok({ published: true, handle: updatedHandle, version });
};

/** `POST /pipeline-definitions/:id/versions`: publish a document as the next version. */
export const publishPipelineVersion = async (
  input: PublishPipelineVersionInput,
  {
    userAuthz,
    dbExecutor,
    ...deps
  }: PublishPipelineGraphVersionDeps & {
    userAuthz: UserAuthorizationService;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    PublishPipelineVersionResult,
    ResourceNotFoundError | CoreValidationError
  >
> => {
  const parsed = publishPipelineVersionInputSchema.parse(input);
  const pipelineGraphId = parsed.pipelineDefinitionId;
  const run = async (
    tx: DbExecutor,
  ): Promise<
    Result<
      PublishPipelineVersionResult,
      ResourceNotFoundError | CoreValidationError
    >
  > => {
    const handle = await deps.pipelineGraphRepo.lockHandle(pipelineGraphId, tx);
    if (!handle) {
      return Result.err(
        new ResourceNotFoundError("Pipeline graph", pipelineGraphId),
      );
    }
    await userAuthz.requireProjectPermission({
      projectId: handle.projectId,
      permission: "pipelines:write",
    });
    if (handle.isArchived) {
      return Result.err(
        new CoreValidationError(
          "An archived pipeline can't be published to",
          "PIPELINE_GRAPH_ARCHIVED",
        ),
      );
    }
    const outcome = await publishPipelineGraphVersion(
      handle,
      parsed.document,
      deps,
      tx,
    );
    if (!outcome.ok) {
      return outcome;
    }
    const { published, handle: updated, version } = outcome.value;
    const current = updated.currentVersionId
      ? await deps.pipelineGraphVersionRepo.load(updated.currentVersionId, tx)
      : null;
    return Result.ok({
      published,
      version: pipelineGraphVersionEntityToContract(version),
      pipelineDefinition: pipelineGraphEntityToContract({
        handle: updated,
        currentVersion: current,
      }),
    });
  };
  return dbExecutor
    ? await dbExecutor.transaction(run)
    : await getDb().transaction(run);
};
