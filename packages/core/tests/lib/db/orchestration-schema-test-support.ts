import { sql } from "drizzle-orm";
import { expect } from "bun:test";
import type pg from "pg";
import { getDb } from "@/lib/db";

/**
 * Raw-SQL seeding and assertion helpers for
 * `orchestration-schema.integration.test.ts`. They bypass the application
 * layer on purpose: that suite asserts on constraints the schema enforces.
 */
export type Scenario = {
  projectId: string;
  workItemId: string;
  taskExecutionConfigId: string | null;
};

type PgError = { code?: string; constraint?: string };

export const newId = (): string => crypto.randomUUID();

// eslint-disable-next-line local/no-unknown-parameter-type -- walks an arbitrary thrown value's `cause` chain to find the driver error.
const pgErrorOf = (err: unknown): PgError => {
  let current: unknown = err;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && typeof current.code === "string") {
      return current as PgError;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return {};
};

export const expectPgError = async (
  run: () => Promise<unknown>,
  expected: { code: string; constraint: string },
): Promise<void> => {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const pgError = pgErrorOf(caught);
  expect(pgError.code).toBe(expected.code);
  expect(pgError.constraint).toBe(expected.constraint);
};

export const insertWorkItem = async (projectId: string): Promise<string> => {
  const id = newId();
  await getDb().execute(sql`
    INSERT INTO "app"."work_items"
      ("id", "project_id", "platform", "platform_key", "title")
    VALUES
      (${id}, ${projectId}, 'github', ${`issue-${id}`}, 'Schema test item')
  `);
  return id;
};

/**
 * Inserts a task execution config row. `content_hash` only has to be unique
 * per project, so a random one stands in for a real hash.
 */
export const insertTaskExecutionConfig = async (
  projectId: string,
  contentHash: string = newId(),
): Promise<string> => {
  const id = newId();
  await getDb().execute(sql`
    INSERT INTO "app"."task_execution_configs"
      ("id", "project_id", "schema_version", "content_hash", "git_json")
    VALUES
      (${id}, ${projectId}, 1, ${contentHash}, '{"mode":"readOnly"}'::jsonb)
  `);
  return id;
};

export const insertTask = async (
  scenario: Scenario,
  values: {
    kind: "agent" | "code" | "mcp_tool";
    prompt: string | null;
    entrypointJson: Record<string, unknown> | null;
    toolCallJson?: Record<string, unknown> | null;
  },
): Promise<string> => {
  const id = newId();
  const jsonOrNull = (value: Record<string, unknown> | null | undefined) =>
    value == null ? null : JSON.stringify(value);
  await getDb().execute(sql`
    INSERT INTO "app"."tasks"
      ("id", "project_id", "work_item_id", "task_execution_config_id", "kind",
       "prompt", "entrypoint_json", "tool_call_json", "status", "schema_version")
    VALUES
      (${id}, ${scenario.projectId}, ${scenario.workItemId},
       ${scenario.taskExecutionConfigId}, ${values.kind}, ${values.prompt},
       ${jsonOrNull(values.entrypointJson)}::jsonb,
       ${jsonOrNull(values.toolCallJson)}::jsonb, 'queued', 1)
  `);
  return id;
};

export const insertAgentTask = (scenario: Scenario): Promise<string> =>
  insertTask(scenario, {
    kind: "agent",
    prompt: "Do the thing",
    entrypointJson: null,
  });

/** Inserts an agent Task plus its first run and returns the run's id. */
export const insertAgentTaskRun = async (
  scenario: Scenario,
): Promise<string> => {
  const taskId = await insertAgentTask(scenario);
  const id = newId();
  await getDb().execute(sql`
    INSERT INTO "app"."task_runs"
      ("id", "task_id", "project_id", "work_item_id", "number", "reason",
       "status")
    VALUES
      (${id}, ${taskId}, ${scenario.projectId}, ${scenario.workItemId}, 1,
       'initial', 'pending')
  `);
  return id;
};

/**
 * Inserts an agent session. Omitting `conversationRootId` makes the session
 * its own conversation root.
 */
export const insertAgentSession = async (values: {
  taskId: string;
  conversationRootId?: string;
}): Promise<string> => {
  const id = newId();
  const conversationRootId = values.conversationRootId ?? id;
  await getDb().execute(sql`
    INSERT INTO "app"."agent_sessions"
      ("id", "task_run_id", "conversation_root_id", "provider",
       "external_session_id", "status", "started_at")
    VALUES
      (${id}, ${values.taskId}, ${conversationRootId}, 'opencode',
       ${`ses_${id}`}, 'running', now())
  `);
  return id;
};

export const seedScenario = async (): Promise<Scenario> => {
  const projectId = newId();
  await getDb().execute(sql`
    INSERT INTO "app"."projects"
      ("id", "name", "slug", "git_url", "created_by_user_id", "org_id")
    VALUES
      (${projectId}, 'Orchestration schema test',
       ${`orchestration-schema-${projectId}`},
       'https://github.com/example/orchestration-schema.git',
       ${newId()}, ${newId()})
  `);
  const workItemId = await insertWorkItem(projectId);
  const taskExecutionConfigId = await insertTaskExecutionConfig(projectId);
  return { projectId, workItemId, taskExecutionConfigId };
};

export const selectRow = async <T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T | undefined> => {
  const { rows } = (await getDb().execute(query)) as pg.QueryResult<T>;
  return rows[0];
};
