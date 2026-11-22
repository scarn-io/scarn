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
  PersistenceError,
  ResourceConflictError,
} from "@scarn/core/lib/errors";
import type { StepDefinitionRepo } from "../application/step-definition-repo";
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
  taskExecutionConfigId: stepDefinition.taskExecutionConfigId,
  status: stepDefinition.status,
  createdAt: stepDefinition.createdAt ?? new Date(),
  updatedAt: stepDefinition.updatedAt ?? new Date(),
});

export class DrizzleStepDefinitionRepo implements StepDefinitionRepo {
  private toEntity(
    row: typeof stepDefinitions.$inferSelect,
  ): StepDefinitionEntity {
    return StepDefinitionEntity.rehydrate({
      id: row.id as StepDefinitionEntityProps["id"],
      projectId: row.projectId as StepDefinitionEntityProps["projectId"],
      key: row.key,
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      version: row.version,
      kind: row.kind,
      entrypointJson:
        row.entrypointJson as StepDefinitionEntityProps["entrypointJson"],
      toolCallJson:
        row.toolCallJson as StepDefinitionEntityProps["toolCallJson"],
      inputSchemaJson:
        row.inputSchemaJson as StepDefinitionEntityProps["inputSchemaJson"],
      resultSchemaJson:
        row.resultSchemaJson as StepDefinitionEntityProps["resultSchemaJson"],
      errors: row.errorsJson as string[],
      retry: row.retryJson as StepDefinitionEntityProps["retry"],
      grants: row.grantsJson as StepDefinitionEntityProps["grants"],
      maxTurns: row.maxTurns,
      concurrency:
        row.concurrencyJson as StepDefinitionEntityProps["concurrency"],
      taskExecutionConfigId:
        row.taskExecutionConfigId === null
          ? null
          : parseUuidV7(row.taskExecutionConfigId),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private loadManyFromRows(
    rows: (typeof stepDefinitions.$inferSelect)[],
  ): StepDefinitionEntity[] {
    return rows.map((row) => this.toEntity(row));
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

    return this.toEntity(row);
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

    return this.toEntity(row);
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
