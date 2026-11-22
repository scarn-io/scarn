import { createHash } from "node:crypto";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError, PersistenceError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { canonicalJson } from "@scarn/core/lib/canonical-json";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { PipelineGraphRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-repo";
import {
  automationDocumentSchema,
  type AutomationDocument,
} from "@scarn/sdk/contracts/automation-document";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { validateAutomation } from "@scarn/shared-core/automations";
import { formatValidationError } from "@scarn/shared-core/pipelines";
import {
  publishAutomationInputSchema,
  type PublishAutomationInput,
  type PublishAutomationResult,
} from "../contracts/automation-contracts";
import { AutomationEntity } from "../domain/automation-entity";
import { AutomationVersionEntity } from "../domain/automation-version-entity";
import type { AutomationRepo } from "./automation-repo";
import { automationToContract } from "./automation-contract-mapper";

export type PublishAutomationDeps = {
  automationRepo: AutomationRepo;
  stepDefinitionRepo: StepDefinitionRepo;
  pipelineGraphRepo: PipelineGraphRepo;
  timeProvider: TimeProvider;
};

/** sha256 of the canonical document. */
export const hashAutomationDocument = (document: AutomationDocument): string =>
  createHash("sha256").update(canonicalJson(document)).digest("hex");

const targetKeysOf = (document: AnyJsonObject) => {
  const parsed = automationDocumentSchema.safeParse(document);
  const targets = parsed.success
    ? parsed.data.rules.flatMap((rule) => [
        ...rule.next.routes,
        ...(rule.next.otherwise ? [rule.next.otherwise] : []),
      ])
    : [];
  const keysOf = (kind: "step" | "pipeline") => [
    ...new Set(
      targets.flatMap((target) => (target.kind === kind ? [target.to] : [])),
    ),
  ];
  return { steps: keysOf("step"), pipelines: keysOf("pipeline") };
};

/** Keys of the pipelines (among `keys`) that are unarchived and have an active version. */
const activePipelineKeys = async (
  projectId: UuidV7,
  keys: readonly string[],
  pipelineGraphRepo: PipelineGraphRepo,
  tx: DbExecutor,
): Promise<Set<string>> => {
  const handles = await Promise.all(
    keys.map((key) => pipelineGraphRepo.findHandleByKey(projectId, key, tx)),
  );
  return new Set(
    handles.flatMap((handle) =>
      handle && !handle.isArchived && handle.currentVersionId !== null
        ? [handle.key]
        : [],
    ),
  );
};

const validate = async (
  projectId: UuidV7,
  key: string,
  document: AnyJsonObject,
  deps: PublishAutomationDeps,
  tx: DbExecutor,
): Promise<Result<AutomationDocument, CoreValidationError>> => {
  const keys = targetKeysOf(document);
  const stepDefinitions = await deps.stepDefinitionRepo.listLatestActiveByKeys(
    projectId,
    keys.steps,
    tx,
  );
  const steps: StepCatalog = Object.fromEntries(
    stepDefinitions.map((step) => [
      step.key,
      {
        inputSchema: step.inputSchemaJson,
        resultSchema: step.resultSchemaJson,
        errors: step.errors,
      },
    ]),
  );
  const automations = await deps.automationRepo.scopesByKey(projectId, tx);
  const scope = automationDocumentSchema.safeParse(document).data?.scope;
  if (scope !== undefined) {
    automations.set(key, scope);
  }
  const validation = validateAutomation(document, {
    steps,
    pipelines: await activePipelineKeys(
      projectId,
      keys.pipelines,
      deps.pipelineGraphRepo,
      tx,
    ),
    automations,
  });
  if (!validation.ok) {
    return Result.err(
      new CoreValidationError(
        `Automation document is invalid:\n${validation.errors.map(formatValidationError).join("\n")}`,
        "AUTOMATION_DOCUMENT_INVALID",
        { errors: validation.errors },
      ),
    );
  }
  if (validation.document.key !== key) {
    return Result.err(
      new CoreValidationError(
        `Automation document key '${validation.document.key}' does not match automation '${key}'`,
        "AUTOMATION_DOCUMENT_KEY_MISMATCH",
      ),
    );
  }
  return Result.ok(validation.document);
};

/** The automation with this key, created (disabled, with no versions) when the project has none. */
const lockOrCreate = async (
  projectId: UuidV7,
  document: AutomationDocument,
  deps: PublishAutomationDeps,
  tx: DbExecutor,
): Promise<AutomationEntity> => {
  const existing = await deps.automationRepo.lockByKey(
    projectId,
    document.key,
    tx,
  );
  if (existing) {
    return existing;
  }
  await deps.automationRepo.insert(
    AutomationEntity.create({
      projectId,
      key: document.key,
      title: document.title ?? null,
      scope: document.scope,
    }),
    tx,
  );
  const locked = await deps.automationRepo.lockByKey(
    projectId,
    document.key,
    tx,
  );
  if (!locked) {
    throw new PersistenceError(`Automation '${document.key}' was not created`);
  }
  return locked;
};

/**
 * Validates `document` and stores it as the automation's next version,
 * creating the automation on its first publish. When the document matches
 * the latest version, nothing is written. An automation's scope can't
 * change once published. Must run inside the caller's transaction.
 */
export const publishAutomationDocument = async (
  projectId: UuidV7,
  key: string,
  document: AnyJsonObject,
  deps: PublishAutomationDeps,
  tx: DbExecutor,
): Promise<Result<PublishAutomationResult, CoreValidationError>> => {
  const validated = await validate(projectId, key, document, deps, tx);
  if (!validated.ok) {
    return validated;
  }
  const validDocument = validated.value;
  const automation = await lockOrCreate(projectId, validDocument, deps, tx);
  if (automation.scope !== validDocument.scope) {
    return Result.err(
      new CoreValidationError(
        `Automation '${key}' is a ${automation.scope} automation; its scope can't change to ${validDocument.scope}`,
        "AUTOMATION_SCOPE_CHANGED",
      ),
    );
  }
  const contentHash = hashAutomationDocument(validDocument);
  const latest = await deps.automationRepo.loadLatestVersion(automation.id, tx);
  if (latest?.contentHash === contentHash) {
    return Result.ok({
      published: false,
      automation: automationToContract({ automation, latestVersion: latest }),
    });
  }
  const now = deps.timeProvider.now();
  const version = await deps.automationRepo.insertVersion(
    AutomationVersionEntity.create({
      automationId: automation.id,
      version: (latest?.version ?? 0) + 1,
      document: validDocument,
      schemaVersion: validDocument.schemaVersion,
      contentHash,
      publishedAt: now,
    }),
    tx,
  );
  const updated = await deps.automationRepo.update(
    automation.withTitle(validDocument.title ?? null, now),
    tx,
  );
  return Result.ok({
    published: true,
    automation: automationToContract({
      automation: updated,
      latestVersion: version,
    }),
  });
};

/** `PUT /projects/:projectId/automations/:key`: publish a document as the automation's next version. */
export const publishAutomation = async (
  input: PublishAutomationInput,
  {
    userAuthz,
    dbExecutor,
    ...deps
  }: PublishAutomationDeps & {
    userAuthz: UserAuthorizationService;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<PublishAutomationResult, CoreValidationError>> => {
  const parsed = publishAutomationInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId: parsed.projectId,
    permission: "pipelines:write",
    dbExecutor,
  });
  const run = (tx: DbExecutor) =>
    publishAutomationDocument(
      parsed.projectId,
      parsed.key,
      parsed.document,
      deps,
      tx,
    );
  return dbExecutor
    ? await dbExecutor.transaction(run)
    : await getDb().transaction(run);
};
