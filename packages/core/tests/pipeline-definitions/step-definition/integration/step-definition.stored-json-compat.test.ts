/**
 * Stored `step_definitions` rows stay readable as the step-definition write
 * rules evolve. Rows are written directly, bypassing the entity, to stand in
 * for step definitions created by older code. See
 * `docs/persistence/json-columns.md`.
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { Logger } from "@scarn/observability/logging";
import { getDb } from "@/lib/db";
import { projects, stepDefinitions } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleStepDefinitionRepo } from "@/pipeline-definitions/step-definition/infra/drizzle-step-definition-repo";
import { concurrentTest } from "tests/utils";
import v1AgentFixture from "../fixtures/v1-agent.json";
import v1CodeFixture from "../fixtures/v1-code.json";
import v1McpToolFixture from "../fixtures/v1-mcp-tool.json";
import v1RetryGrantsConcurrencyFixture from "../fixtures/v1-retry-grants-concurrency.json";

type StoredRow = {
  schemaVersion: number;
  kind: "built_in" | "user_defined" | "code" | "mcp_tool";
  prompt: string | null;
  entrypointJson: unknown;
  toolCallJson: unknown;
  inputSchemaJson: unknown;
  resultSchemaJson: unknown;
  errorsJson: unknown;
  retryJson: unknown;
  grantsJson: unknown;
  concurrencyJson: unknown;
};

const recordingLogger = () => {
  const errors: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, errors };
};

const seedProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "step-definition stored json compat",
      slug: `step-definition-stored-json-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const insertRow = async (
  projectId: UuidV7,
  row: StoredRow,
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(stepDefinitions)
    .values({
      id,
      projectId,
      key: `stored_${crypto.randomUUID()}`,
      name: "Stored step",
      prompt: row.prompt,
      version: 1,
      kind: row.kind,
      entrypointJson: row.entrypointJson,
      toolCallJson: row.toolCallJson,
      inputSchemaJson: row.inputSchemaJson,
      resultSchemaJson: row.resultSchemaJson,
      errorsJson: row.errorsJson,
      retryJson: row.retryJson,
      grantsJson: row.grantsJson,
      concurrencyJson: row.concurrencyJson,
      schemaVersion: row.schemaVersion,
      taskExecutionConfigId: null,
      status: "active",
    });
  return id;
};

const rejectionOf = async <T>(promise: Promise<T>) => {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
};

const withProject = async (run: (projectId: UuidV7) => Promise<void>) => {
  const projectId = await seedProject();
  try {
    await run(projectId);
  } finally {
    await getDb().delete(projects).where(eq(projects.id, projectId));
  }
};

describe("step definition stored json compatibility", () => {
  for (const [name, fixture] of [
    ["agent", v1AgentFixture],
    ["code", v1CodeFixture],
    ["mcp-tool", v1McpToolFixture],
    ["retry-grants-concurrency", v1RetryGrantsConcurrencyFixture],
  ] as const) {
    concurrentTest(`reads the v1 ${name} fixture through the repo`, () =>
      withProject(async (projectId) => {
        const id = await insertRow(projectId, fixture as StoredRow);
        const repo = new DrizzleStepDefinitionRepo();

        const loaded = await repo.load(id);
        const listed = (await repo.listByProjectId(projectId)).find(
          (stepDefinition) => stepDefinition.id === id,
        );

        for (const stepDefinition of [loaded, listed]) {
          expect<string | undefined>(stepDefinition?.kind).toBe(fixture.kind);
          expect(stepDefinition?.entrypointJson).toEqual(
            fixture.entrypointJson,
          );
          expect(stepDefinition?.toolCallJson).toEqual(fixture.toolCallJson);
          expect(stepDefinition?.inputSchemaJson).toEqual(
            fixture.inputSchemaJson,
          );
          expect(stepDefinition?.resultSchemaJson).toEqual(
            fixture.resultSchemaJson,
          );
          expect(stepDefinition?.errors).toEqual(fixture.errorsJson);
          expect(stepDefinition?.retry).toEqual(fixture.retryJson);
          expect(stepDefinition?.grants as unknown).toEqual(fixture.grantsJson);
          expect(stepDefinition?.concurrency).toEqual(fixture.concurrencyJson);
        }
      }),
    );
  }

  concurrentTest("reads a row that today's write rules would refuse", () =>
    withProject(async (projectId) => {
      const grantsJson = [
        { resource: "workItem", action: "read", scope: "self" },
        { resource: "workItem", action: "read", scope: "self" },
        { resource: "workItem", action: "retired_action", scope: "self" },
      ];
      const id = await insertRow(projectId, {
        ...(v1AgentFixture as StoredRow),
        errorsJson: [" Padded.Error ", "Dup", "Dup"],
        retryJson: [{ on: ["Never.Declared"], maxAttempts: 0 }],
        grantsJson,
        concurrencyJson: { max: 0, waiting: -1 },
      });

      const loaded = await new DrizzleStepDefinitionRepo().load(id);

      expect(loaded?.errors).toEqual([" Padded.Error ", "Dup", "Dup"]);
      expect(loaded?.retry).toEqual([
        { on: ["Never.Declared"], maxAttempts: 0 },
      ]);
      expect(loaded?.grants as unknown).toEqual(grantsJson);
      expect(loaded?.concurrency).toEqual({ max: 0, waiting: -1 });
    }),
  );

  concurrentTest(
    "an unreadable step definition is logged with its id and skipped by list reads, and throws on single reads",
    () =>
      withProject(async (projectId) => {
        const { logger, errors } = recordingLogger();
        const repo = new DrizzleStepDefinitionRepo(logger);
        const readableId = await insertRow(
          projectId,
          v1AgentFixture as StoredRow,
        );
        const badGrantsId = await insertRow(projectId, {
          ...(v1AgentFixture as StoredRow),
          grantsJson: { resource: "workItem" },
        });
        const futureVersionId = await insertRow(projectId, {
          ...(v1AgentFixture as StoredRow),
          schemaVersion: 99,
        });

        const listed = await repo.listByProjectId(projectId);
        expect(listed.map((stepDefinition) => stepDefinition.id)).toEqual([
          readableId,
        ]);

        const loadedMany = await repo.loadMany([
          readableId,
          badGrantsId,
          futureVersionId,
        ]);
        expect(loadedMany.map((stepDefinition) => stepDefinition.id)).toEqual([
          readableId,
        ]);

        const loggedIds = errors.map(
          ([fields]) =>
            (fields as { stepDefinitionId?: string }).stepDefinitionId,
        );
        expect(loggedIds).toContain(badGrantsId);
        expect(loggedIds).toContain(futureVersionId);

        for (const id of [badGrantsId, futureVersionId]) {
          expect(await rejectionOf(repo.load(id))).toMatchObject({
            code: "STEP_DEFINITION_ROW_UNREADABLE",
          });
        }
      }),
  );
});
