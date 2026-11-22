import { sql } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import {
  expectPgError,
  insertAgentSession,
  insertAgentTask,
  insertAgentTaskRun,
  insertTask,
  insertTaskExecutionConfig,
  insertWorkItem,
  newId,
  seedScenario,
  selectRow,
} from "./orchestration-schema-test-support";

/**
 * Database-level coverage for the orchestration data model (see
 * docs/orchestration-data-model/). The test
 * preload has already applied every migration to the shared test container,
 * so these tests seed rows with raw SQL and assert on the constraints the
 * schema itself enforces. No application modules are used, because the app
 * layer has not yet been moved onto the new tables.
 */
const toolCallJson = {
  server: "notion",
  tool: "search",
  argsTemplate: { query: "{{input.query}}" },
  toolSchemas: { input: { type: "object" }, output: null },
};

describe("orchestration schema", () => {
  describe("tasks_kind_instructions_check", () => {
    test.concurrent(
      "accepts an agent task, a code task and an mcp_tool task",
      async () => {
        const scenario = await seedScenario();

        const agentTaskId = await insertAgentTask(scenario);
        const codeTaskId = await insertTask(scenario, {
          kind: "code",
          prompt: null,
          entrypointJson: { sourceFile: "steps/run.ts" },
        });
        const mcpToolTaskId = await insertTask(scenario, {
          kind: "mcp_tool",
          prompt: null,
          entrypointJson: null,
          toolCallJson,
        });

        const row = await selectRow<{ count: number }>(sql`
          SELECT count(*)::int AS "count" FROM "app"."tasks"
          WHERE "id" IN (${agentTaskId}, ${codeTaskId}, ${mcpToolTaskId})
        `);
        expect(row?.count).toBe(3);
      },
    );

    const invalidCombinations: Array<{
      name: string;
      kind: "agent" | "code" | "mcp_tool";
      prompt: string | null;
      entrypointJson: Record<string, unknown> | null;
      toolCallJson?: Record<string, unknown> | null;
    }> = [
      {
        name: "agent without a prompt",
        kind: "agent",
        prompt: null,
        entrypointJson: null,
      },
      {
        name: "agent with an entrypoint",
        kind: "agent",
        prompt: "Do the thing",
        entrypointJson: { sourceFile: "steps/run.ts" },
      },
      {
        name: "code without an entrypoint",
        kind: "code",
        prompt: null,
        entrypointJson: null,
      },
      {
        name: "code with a prompt",
        kind: "code",
        prompt: "Do the thing",
        entrypointJson: { sourceFile: "steps/run.ts" },
      },
      {
        name: "agent with a tool call",
        kind: "agent",
        prompt: "Do the thing",
        entrypointJson: null,
        toolCallJson,
      },
      {
        name: "code with a tool call",
        kind: "code",
        prompt: null,
        entrypointJson: { sourceFile: "steps/run.ts" },
        toolCallJson,
      },
      {
        name: "mcp_tool without a tool call",
        kind: "mcp_tool",
        prompt: null,
        entrypointJson: null,
      },
      {
        name: "mcp_tool with a prompt",
        kind: "mcp_tool",
        prompt: "Do the thing",
        entrypointJson: null,
        toolCallJson,
      },
      {
        name: "mcp_tool with an entrypoint",
        kind: "mcp_tool",
        prompt: null,
        entrypointJson: { sourceFile: "steps/run.ts" },
        toolCallJson,
      },
    ];

    for (const combination of invalidCombinations) {
      test.concurrent(`rejects ${combination.name}`, async () => {
        const scenario = await seedScenario();

        await expectPgError(() => insertTask(scenario, combination), {
          code: "23514",
          constraint: "tasks_kind_instructions_check",
        });
      });
    }
  });

  describe("task execution configs", () => {
    test.concurrent("are unique per (project_id, content_hash)", async () => {
      const scenario = await seedScenario();
      const contentHash = newId();

      await insertTaskExecutionConfig(scenario.projectId, contentHash);
      await expectPgError(
        () => insertTaskExecutionConfig(scenario.projectId, contentHash),
        {
          code: "23505",
          constraint: "task_execution_configs_project_content_hash_unique",
        },
      );
    });

    test.concurrent(
      "rejects deleting a config referenced by a task",
      async () => {
        const scenario = await seedScenario();
        await insertAgentTask(scenario);

        await expectPgError(
          () =>
            getDb().execute(sql`
              DELETE FROM "app"."task_execution_configs"
              WHERE "id" = ${scenario.taskExecutionConfigId}
            `),
          {
            code: "23503",
            constraint:
              "tasks_task_execution_config_id_task_execution_configs_id_fk",
          },
        );
      },
    );

    test.concurrent(
      "rejects deleting a config referenced by a step definition",
      async () => {
        const scenario = await seedScenario();
        await getDb().execute(sql`
          INSERT INTO "app"."step_definitions"
            ("id", "project_id", "key", "name", "prompt", "version", "kind",
             "input_schema_json", "result_schema_json",
             "task_execution_config_id", "status")
          VALUES
            (${newId()}, ${scenario.projectId}, 'triage', 'Triage',
             'Triage the issue', 1, 'user_defined',
             '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
             ${scenario.taskExecutionConfigId}, 'active')
        `);

        await expectPgError(
          () =>
            getDb().execute(sql`
              DELETE FROM "app"."task_execution_configs"
              WHERE "id" = ${scenario.taskExecutionConfigId}
            `),
          {
            code: "23503",
            // Postgres truncates the drizzle-generated name to 63 characters.
            constraint:
              "step_definitions_task_execution_config_id_task_execution_config",
          },
        );
      },
    );

    test.concurrent("a task may reference no config", async () => {
      const scenario = await seedScenario();
      const taskId = await insertAgentTask({
        ...scenario,
        taskExecutionConfigId: null,
      });

      const row = await selectRow<{
        task_execution_config_id: string | null;
      }>(sql`
          SELECT "task_execution_config_id" FROM "app"."tasks"
          WHERE "id" = ${taskId}
        `);
      expect(row?.task_execution_config_id).toBeNull();
    });
  });

  describe("agent session chain", () => {
    test.concurrent(
      "links segments across tasks and nulls the root link when the root's task is deleted",
      async () => {
        const scenario = await seedScenario();
        const rootTaskId = await insertAgentTaskRun(scenario);
        const rootSessionId = await insertAgentSession({ taskId: rootTaskId });
        const resumedTaskId = await insertAgentTaskRun(scenario);
        const segmentSessionId = await insertAgentSession({
          taskId: resumedTaskId,
          conversationRootId: rootSessionId,
        });

        const root = await selectRow<{ conversation_root_id: string }>(sql`
          SELECT "conversation_root_id" FROM "app"."agent_sessions"
          WHERE "id" = ${rootSessionId}
        `);
        expect(root?.conversation_root_id).toBe(rootSessionId);

        const segmentBeforeDelete = await selectRow<{
          conversation_root_id: string;
        }>(sql`
          SELECT "conversation_root_id" FROM "app"."agent_sessions"
          WHERE "id" = ${segmentSessionId}
        `);
        expect(segmentBeforeDelete?.conversation_root_id).toBe(rootSessionId);

        await getDb().execute(sql`
          DELETE FROM "app"."task_runs" WHERE "id" = ${rootTaskId}
        `);

        const segment = await selectRow<{
          task_run_id: string;
          conversation_root_id: string | null;
        }>(sql`
          SELECT "task_run_id", "conversation_root_id" FROM "app"."agent_sessions"
          WHERE "id" = ${segmentSessionId}
        `);
        expect(segment).toEqual({
          task_run_id: resumedTaskId,
          conversation_root_id: null,
        });
      },
    );
  });

  describe("work items", () => {
    test.concurrent("state defaults to open", async () => {
      const scenario = await seedScenario();

      const row = await selectRow<{ state: string }>(sql`
        SELECT "state" FROM "app"."work_items"
        WHERE "id" = ${scenario.workItemId}
      `);
      expect(row?.state).toBe("open");
    });

    test.concurrent(
      "deleting the spawning task nulls spawned_by_task_id",
      async () => {
        const scenario = await seedScenario();
        const taskId = await insertAgentTask(scenario);
        const childWorkItemId = await insertWorkItem(scenario.projectId);
        await getDb().execute(sql`
          UPDATE "app"."work_items" SET "spawned_by_task_id" = ${taskId}
          WHERE "id" = ${childWorkItemId}
        `);

        await getDb().execute(sql`
          DELETE FROM "app"."tasks" WHERE "id" = ${taskId}
        `);

        const row = await selectRow<{ spawned_by_task_id: string | null }>(sql`
          SELECT "spawned_by_task_id" FROM "app"."work_items"
          WHERE "id" = ${childWorkItemId}
        `);
        expect(row?.spawned_by_task_id).toBeNull();
      },
    );
  });
});
