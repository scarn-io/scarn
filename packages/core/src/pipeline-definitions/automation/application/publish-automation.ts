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
  schedulesOf,
  type AutomationDocument,
} from "@scarn/sdk/contracts/automation-document";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { validateAutomation } from "@scarn/shared-core/automations";
import {
  formatValidationError,
  type ValidationError,
} from "@scarn/shared-core/pipelines";
import {
  workItemScopedGrants,
  type Grant,
} from "@scarn/core/tasks/task/domain/grants";
import {
  publishAutomationInputSchema,
  type PublishAutomationInput,
  type PublishAutomationResult,
} from "../contracts/automation-contracts";
import { AutomationEntity } from "../domain/automation-entity";
import { AutomationVersionEntity } from "../domain/automation-version-entity";
import type { AutomationRepo } from "./automation-repo";
import type { AutomationScheduleRepo } from "./automation-schedule-repo";
import { automationToContract } from "./automation-contract-mapper";
import {
  checkScheduleLimit,
  syncAutomationSchedules,
} from "./automation-schedules";

export type PublishAutomationDeps = {
  automationRepo: AutomationRepo;
  automationScheduleRepo: AutomationScheduleRepo;
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
  const grantErrors = scheduledStepGrantErrors(
    validation.document,
    new Map(stepDefinitions.map((step) => [step.key, step.grants])),
  );
  if (grantErrors.length > 0) {
    return Result.err(
      new CoreValidationError(
        `Automation document is invalid:\n${grantErrors.map(formatValidationError).join("\n")}`,
        "AUTOMATION_DOCUMENT_INVALID",
        { errors: grantErrors },
      ),
    );
  }
  return Result.ok(validation.document);
};

/**
 * A scheduled Task has no work item, so it keeps only its step's `project`
 * grants: a `schedule` rule may not start a step with grants on `self` or
 * `children`, which would silently do nothing.
 */
const scheduledStepGrantErrors = (
  document: AutomationDocument,
  grantsByStep: ReadonlyMap<string, readonly Grant[]>,
): ValidationError[] =>
  document.rules.flatMap((rule, ruleIndex) => {
    if (rule.event !== "schedule") {
      return [];
    }
    const targets = [
      ...rule.next.routes.map((target, index) => ({
        target,
        path: `routes/${String(index)}`,
      })),
      ...(rule.next.otherwise
        ? [{ target: rule.next.otherwise, path: "otherwise" }]
        : []),
    ];
    return targets.flatMap(({ target, path }) => {
      if (target.kind !== "step") {
        return [];
      }
      const offending = workItemScopedGrants(grantsByStep.get(target.to) ?? []);
      if (offending.length === 0) {
        return [];
      }
      return [
        {
          code: "schema" as const,
          path: `/rules/${String(ruleIndex)}/next/${path}/to`,
          message: `Schedule rule '${rule.key}' starts step '${target.to}', which has grants a scheduled Task can't use: ${offending.map((grant) => `${grant.action} on ${grant.scope}`).join(", ")}`,
          hint: "A scheduled Task has no work item; give the step only `project` grants",
        },
      ];
    });
  });

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
 * change once published. Its `schedule` rules are synced to
 * `automation_schedules` (see `automation-schedules.ts`), and an enabled
 * automation can't take the project over its schedule limit. Must run
 * inside the caller's transaction.
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
  if (automation.enabled) {
    const overLimit = await checkScheduleLimit(
      automation,
      schedulesOf(validDocument).length,
      deps.automationScheduleRepo,
      tx,
    );
    if (overLimit) {
      return Result.err(overLimit);
    }
  }
  const now = deps.timeProvider.now();
  await syncAutomationSchedules(
    automation,
    validDocument,
    now,
    deps.automationScheduleRepo,
    tx,
  );
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
