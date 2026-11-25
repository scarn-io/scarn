import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  stepDefinitions,
  taskExecutionConfigs,
} from "@scarn/core/lib/db/schema";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import {
  CoreError,
  PersistenceError,
  ResourceConflictError,
} from "@scarn/core/lib/errors";
import {
  readRowsSkippingUnreadable,
  type StoredReadResult,
} from "@scarn/core/lib/db/stored-json";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { StepDefinitionRepo } from "../application/step-definition-repo";
import {
  CURRENT_STEP_DEFINITION_SCHEMA_VERSION,
  readStoredStepDefinition,
} from "../contracts/step-definition-stored";
import {
  StepDefinitionEntity,
  type StepDefinitionEntityProps,
} from "../domain/step-definition-entity";

const toStepDefinitionRow = (stepDefinition: StepDefinitionEntity) => ({
  id: stepDefinition.id,
  projectId: stepDefinition.projectId,
  key: stepDefinition.key,
  name: stepDefinition.name,
  description: stepDefinition.description,
  prompt: stepDefinition.prompt,
  version: stepDefinition.version,
  kind: stepDefinition.kind,
  entrypointJson: stepDefinition.entrypointJson,
  toolCallJson: stepDefinition.toolCallJson,
  inputSchemaJson: stepDefinition.inputSchemaJson,
  resultSchemaJson: stepDefinition.resultSchemaJson,
  errorsJson: [...stepDefinition.errors],
  retryJson: [...stepDefinition.retry],
  grantsJson: [...stepDefinition.grants],
  maxTurns: stepDefinition.maxTurns,
  concurrencyJson: stepDefinition.concurrency,
  schemaVersion: CURRENT_STEP_DEFINITION_SCHEMA_VERSION,
  taskExecutionConfigId: stepDefinition.taskExecutionConfigId,
  status: stepDefinition.status,
  createdAt: stepDefinition.createdAt ?? new Date(),
  updatedAt: stepDefinition.updatedAt ?? new Date(),
});

type StepDefinitionRow = typeof stepDefinitions.$inferSelect;

/**
 * Reads a row through the stored step-definition reader. A row whose JSON
 * columns or ids don't fit is unreadable.
 */
export const readStepDefinitionRow = (
  row: StepDefinitionRow,
): StoredReadResult<StepDefinitionEntity> => {
  const stored = readStoredStepDefinition(row.schemaVersion, row);
  if (!stored.success) {
    return stored;
  }
  const document = stored.value;
  try {
    return {
      success: true,
      value: StepDefinitionEntity.rehydrate({
        id: parseUuidV7(row.id),
        projectId: parseUuidV7(row.projectId),
        key: row.key,
        name: row.name,
        description: row.description,
        prompt: row.prompt,
        version: row.version,
        kind: row.kind,
        entrypointJson: document.entrypointJson,
        toolCallJson: document.toolCallJson,
        inputSchemaJson: document.inputSchemaJson,
        resultSchemaJson: document.resultSchemaJson,
        errors: document.errorsJson,
        retry: document.retryJson,
        grants: document.grantsJson,
        maxTurns: row.maxTurns,
        concurrency: document.concurrencyJson,
        taskExecutionConfigId:
          row.taskExecutionConfigId === null
            ? null
            : parseUuidV7(row.taskExecutionConfigId),
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof CoreError) {
      return { success: false, reason: error.message };
    }
    throw error;
  }
};

/** A row that does not read is a persistence fault: this code wrote it. */
export const stepDefinitionFromRow = (
  row: StepDefinitionRow,
): StepDefinitionEntity => {
  const read = readStepDefinitionRow(row);
  if (!read.success) {
    throw new PersistenceError(
      `step definition ${row.id} is unreadable: ${read.reason}`,
      "STEP_DEFINITION_ROW_UNREADABLE",
    );
  }
  return read.value;
};

/** The log fields that identify a skipped row. */
const describeRow = (row: StepDefinitionRow) => ({
  table: "step_definitions",
  stepDefinitionId: row.id,
  projectId: row.projectId,
  key: row.key,
});

/**
 * Single-row reads throw `STEP_DEFINITION_ROW_UNREADABLE` on a row that
 * doesn't read; list reads log it at `error` with the step definition id and
 * leave it out, so one bad row doesn't fail the project's step list.
 */
export class DrizzleStepDefinitionRepo implements StepDefinitionRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  private loadManyFromRows(
    rows: readonly StepDefinitionRow[],
  ): StepDefinitionEntity[] {
    return readRowsSkippingUnreadable(
      rows,
      readStepDefinitionRow,
      this.logger,
      describeRow,
    );
  }

  async load(id: StepDefinitionEntityProps["id"], dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(stepDefinitions)
      .where(eq(stepDefinitions.id, id))
      .limit(1);

    if (!row) {
      return null;
    }

    return stepDefinitionFromRow(row);
  }

  async findByKey(
    projectId: StepDefinitionEntityProps["projectId"],
    key: string,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(stepDefinitions)
      .where(
        and(
          eq(stepDefinitions.projectId, projectId),
          eq(stepDefinitions.key, key),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return stepDefinitionFromRow(row);
  }

  async listByProjectId(
    projectId: StepDefinitionEntityProps["projectId"],
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(stepDefinitions)
      .where(eq(stepDefinitions.projectId, projectId));

    return this.loadManyFromRows(rows);
  }

  async loadMany(
    ids: readonly StepDefinitionEntityProps["id"][],
    dbExecutor?: DbExecutor,
  ) {
    if (ids.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(stepDefinitions)
      .where(inArray(stepDefinitions.id, [...ids]));
    return this.loadManyFromRows(rows);
  }

  async listLatestActiveByKeys(
    projectId: StepDefinitionEntityProps["projectId"],
    keys: readonly string[],
    dbExecutor?: DbExecutor,
  ) {
    if (keys.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinctOn([stepDefinitions.key])
      .from(stepDefinitions)
      .where(
        and(
          eq(stepDefinitions.projectId, projectId),
          eq(stepDefinitions.status, "active"),
          inArray(stepDefinitions.key, [...keys]),
        ),
      )
      .orderBy(stepDefinitions.key, desc(stepDefinitions.version));
    return this.loadManyFromRows(rows);
  }

  async listLatestActiveByManagedConnectionName(
    projectId: StepDefinitionEntityProps["projectId"],
    name: string,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const latestActive = db
      .selectDistinctOn([stepDefinitions.key])
      .from(stepDefinitions)
      .where(
        and(
          eq(stepDefinitions.projectId, projectId),
          eq(stepDefinitions.status, "active"),
        ),
      )
      .orderBy(stepDefinitions.key, desc(stepDefinitions.version))
      .as("latest_active");
    const rows = await db
      .select()
      .from(latestActive)
      .innerJoin(
        taskExecutionConfigs,
        and(
          eq(taskExecutionConfigs.id, latestActive.taskExecutionConfigId),
          eq(taskExecutionConfigs.projectId, projectId),
        ),
      )
      .where(
        sql`jsonb_path_exists(
        ${taskExecutionConfigs.mcpJson},
        '$.* ? (@.type != "local" && (!exists(@.disabled) || @.disabled != true) && @.auth.connection == $name)',
        jsonb_build_object('name', ${name}::text)
      )`,
      )
      .orderBy(latestActive.key);
    return this.loadManyFromRows(rows.map((row) => row.latest_active));
  }

  async create(stepDefinition: StepDefinitionEntity, dbExecutor?: DbExecutor) {
    const createInExecutor = async (tx: DbExecutor) => {
      try {
        await tx
          .insert(stepDefinitions)
          .values(toStepDefinitionRow(stepDefinition));
      } catch (err) {
        if (isUniqueViolation(err as Error)) {
          throw new ResourceConflictError(
            "step definition",
            `${stepDefinition.projectId}/${stepDefinition.key}`,
          );
        }
        throw err;
      }

      const createdStepDefinition = await this.load(stepDefinition.id, tx);
      if (!createdStepDefinition) {
        throw new PersistenceError(
          `Failed to create step definition ${stepDefinition.id}`,
          "STEP_DEFINITION_CREATE_FAILED",
        );
      }

      return createdStepDefinition;
    };

    if (dbExecutor) {
      return await createInExecutor(dbExecutor);
    }

    return await getDb().transaction(async (tx) => await createInExecutor(tx));
  }

  async save(stepDefinition: StepDefinitionEntity, dbExecutor?: DbExecutor) {
    const saveInExecutor = async (tx: DbExecutor) => {
      await tx
        .insert(stepDefinitions)
        .values(toStepDefinitionRow(stepDefinition))
        .onConflictDoUpdate({
          target: stepDefinitions.id,
          set: {
            projectId: stepDefinition.projectId,
            key: stepDefinition.key,
            name: stepDefinition.name,
            description: stepDefinition.description,
            prompt: stepDefinition.prompt,
            version: stepDefinition.version,
            kind: stepDefinition.kind,
            entrypointJson: stepDefinition.entrypointJson,
            toolCallJson: stepDefinition.toolCallJson,
            inputSchemaJson: stepDefinition.inputSchemaJson,
            resultSchemaJson: stepDefinition.resultSchemaJson,
            errorsJson: [...stepDefinition.errors],
            retryJson: [...stepDefinition.retry],
            grantsJson: [...stepDefinition.grants],
            maxTurns: stepDefinition.maxTurns,
            concurrencyJson: stepDefinition.concurrency,
            schemaVersion: CURRENT_STEP_DEFINITION_SCHEMA_VERSION,
            taskExecutionConfigId: stepDefinition.taskExecutionConfigId,
            status: stepDefinition.status,
            updatedAt: stepDefinition.updatedAt ?? new Date(),
          },
        });

      const savedStepDefinition = await this.load(stepDefinition.id, tx);
      if (!savedStepDefinition) {
        throw new PersistenceError(
          `Failed to save step definition ${stepDefinition.id}`,
          "STEP_DEFINITION_SAVE_FAILED",
        );
      }

      return savedStepDefinition;
    };

    if (dbExecutor) {
      return await saveInExecutor(dbExecutor);
    }

    return await getDb().transaction(async (tx) => await saveInExecutor(tx));
  }
}
