import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTestDatabaseUrl } from "@scarn/local-dev/test-db";
import pg from "pg";
import { anyJsonValueSchema } from "@/common/contracts/json";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import {
  storedTaskExecutionConfigV1Schema,
  storedTaskExecutionConfigV2Schema,
  taskExecutionConfigConverters,
  type HistoricalTaskExecutionConfigColumns,
  type TaskExecutionConfigContentV3,
} from "@/tasks/task-execution-config/contracts/task-execution-config-stored";

const projectId = createUuidV7();
const databaseName = `environment_v3_${crypto.randomUUID().replaceAll("-", "")}`;
let admin: pg.Client | undefined;
let db: pg.Client;
let databaseCreated = false;

beforeAll(async () => {
  const url = new URL(await getTestDatabaseUrl());
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  url.pathname = `/${databaseName}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(`
    CREATE SCHEMA app;
    CREATE TABLE app.task_execution_configs (
      id uuid PRIMARY KEY, project_id uuid NOT NULL,
      schema_version integer NOT NULL, content_hash text NOT NULL,
      runtime_json jsonb, env_json jsonb, git_json jsonb,
      mcp_json jsonb, health_checks_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX task_execution_configs_project_content_hash_unique
      ON app.task_execution_configs(project_id, content_hash);
    CREATE TABLE app.step_definitions (
      id uuid PRIMARY KEY,
      task_execution_config_id uuid REFERENCES app.task_execution_configs(id)
    );
    CREATE TABLE app.tasks (
      id uuid PRIMARY KEY,
      task_execution_config_id uuid REFERENCES app.task_execution_configs(id)
    );
    CREATE TYPE public.secret_kind AS ENUM ('github_token');
    CREATE TABLE app.projects (id uuid PRIMARY KEY);
    CREATE TABLE app.secrets (
      id uuid PRIMARY KEY, owner_user_id uuid NOT NULL,
      name text NOT NULL, kind secret_kind NOT NULL
    );
    CREATE TABLE app.task_runs (id uuid PRIMARY KEY);
  `);
}, 30_000);

afterAll(async () => {
  if (databaseCreated) await db.end();
  if (admin) {
    if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});

type HistoricalFixture = HistoricalTaskExecutionConfigColumns & {
  schemaVersion: number;
};

const fixture = (
  overrides: Partial<HistoricalFixture> = {},
): HistoricalFixture => ({
  schemaVersion: 2,
  runtimeJson: null,
  envJson: null,
  gitJson: null,
  mcpJson: null,
  healthChecksJson: null,
  ...overrides,
});

/** A v1 or v2 row converted up to v3, the shape the migration writes. */
const v3ContentOf = (
  historical: HistoricalFixture,
): TaskExecutionConfigContentV3 => {
  const columns = {
    runtime: historical.runtimeJson,
    env: historical.envJson,
    git: historical.gitJson,
    mcp: historical.mcpJson,
    healthChecks: historical.healthChecksJson,
  };
  const v2 =
    historical.schemaVersion === 1
      ? taskExecutionConfigConverters[1](
          storedTaskExecutionConfigV1Schema.parse(columns),
        )
      : storedTaskExecutionConfigV2Schema.parse(columns);
  return taskExecutionConfigConverters[2](v2);
};

/** The v3 content hash: a default `gitCredentials` is left out. */
const v3ContentHash = (content: TaskExecutionConfigContentV3): string => {
  const git: Partial<NonNullable<TaskExecutionConfigContentV3["git"]>> | null =
    content.git === null ? null : { ...content.git };
  if (git?.gitCredentials === "auto") delete git.gitCredentials;
  return createHash("sha256")
    .update(canonicalJson({ schemaVersion: 3, ...content, git }))
    .digest("hex");
};

describe("stored environment v3 data migration", () => {
  test("rewrites real historical rows, canonical hashes and every duplicate reference", async () => {
    const fixtures = [
      fixture(),
      fixture({ runtimeJson: { type: "host" } }),
      fixture({ runtimeJson: { type: "managed", id: "node24" } }),
      fixture({ runtimeJson: { type: "devcontainer" } }),
      fixture({
        runtimeJson: {
          type: "devcontainer",
          configPath: ".devcontainer/custom.json",
        },
      }),
      fixture({
        schemaVersion: 1,
        runtimeJson: { type: "none" },
        gitJson: { mode: "none" },
      }),
      fixture({ schemaVersion: 1, runtimeJson: { type: "none" } }),
      fixture({
        schemaVersion: 1,
        runtimeJson: { type: "devcontainer" },
        gitJson: { mode: "readOnly" },
        envJson: [
          {
            name: "MODE",
            source: "value",
            value: 'quoted "text"\n\t\\é😀',
            secret: false,
            oldExtra: true,
          },
          {
            name: "TOKEN",
            source: "inherit",
            from: "GITHUB_TOKEN",
            secret: true,
            optional: false,
            default: "fallback",
            mcp: "github",
          },
        ],
        mcpJson: {
          github: {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer {env:TOKEN}" },
            oauth: { callback_port: 65535, scope: "a b" },
            timeout: { startup: 9007199254740991, execution: 1000, catalog: 1 },
            disabled: false,
            codemode: true,
            protocol: "auto",
          },
          "10": { type: "ref", name: "ten" },
          "2": { type: "ref" },
          "😀": { type: "local", command: ["echo", "a\nb"] },
          "\ue000": { type: "remote", url: "https://example.org" },
        },
        healthChecksJson: [
          {
            tool: "list",
            mcp: "github",
            args: {
              nested: [1e-7, 1e-6, 1e20, 1e21, 0.125, -0.5],
              object: { "10": "ten", "2": "two", text: '"\n\t\\é😀' },
            },
          },
          { kind: "cli", command: ["echo", "a b"] },
        ],
      }),
      fixture({
        envJson: [],
        gitJson: {
          mode: "readWrite",
          message: 'custom "commit"',
          onPushFailure: "warn",
        },
      }),
      fixture({
        envJson: [
          {
            name: "SETUP",
            source: "value",
            value: "yes",
            secret: false,
            applies: "setup",
          },
        ],
      }),
    ];
    const ids = fixtures.map(() => createUuidV7());
    for (const [index, historical] of fixtures.entries()) {
      const id = ids[index];
      if (!id) throw new Error("fixture id missing");
      const json = (value: unknown) => {
        const parsed = anyJsonValueSchema.parse(value ?? null);
        return parsed === null ? null : JSON.stringify(parsed);
      };
      await db.query(
        `INSERT INTO app.task_execution_configs (
          id, project_id, schema_version, content_hash,
          runtime_json, env_json, git_json, mcp_json, health_checks_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          projectId,
          historical.schemaVersion,
          `old-${String(index)}`,
          json(historical.runtimeJson),
          json(historical.envJson),
          json(historical.gitJson),
          json(historical.mcpJson),
          json(historical.healthChecksJson),
        ],
      );
      await db.query("INSERT INTO app.step_definitions VALUES ($1, $2)", [
        createUuidV7(),
        id,
      ]);
      await db.query("INSERT INTO app.tasks VALUES ($1, $2)", [
        createUuidV7(),
        id,
      ]);
    }
    const migration = await readFile(
      new URL(
        "../../../drizzle/20261116132444_reusable_environments/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.query("BEGIN");
    try {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.query(statement);
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }

    const { rows } = await db.query<Record<string, unknown>>(`
      SELECT id, schema_version, content_hash, environment_json,
        git_json, mcp_json, health_checks_json
      FROM app.task_execution_configs
    `);
    expect(rows).toHaveLength(fixtures.length - 1);
    for (const [index, historical] of fixtures.entries()) {
      const id = ids[index];
      if (!id) throw new Error("fixture id missing");
      const v3 = v3ContentOf(historical);
      const matching = rows.find(
        (row) =>
          row["id"] ===
          (index === 5 || index === 6
            ? [ids[5], ids[6]].sort()[0]
            : ids[index]),
      );
      expect(matching).toBeDefined();
      expect(matching?.["schema_version"]).toBe(3);
      expect(matching?.["environment_json"]).toEqual(v3.environment);
      expect(matching?.["git_json"]).toEqual(v3.git);
      expect(matching?.["mcp_json"]).toEqual(v3.mcp);
      expect(matching?.["health_checks_json"]).toEqual(v3.healthChecks);
      expect(matching?.["content_hash"]).toBe(v3ContentHash(v3));
    }
    for (const table of ["tasks", "step_definitions"]) {
      const { rows: references } = await db.query<Record<string, unknown>>(
        `SELECT task_execution_config_id AS id FROM app.${table}`,
      );
      expect(references).toHaveLength(fixtures.length);
      for (const reference of references) {
        expect(rows.some((row) => row["id"] === reference["id"])).toBe(true);
      }
      const host = references.filter(
        (reference) => reference["id"] === [ids[5], ids[6]].sort()[0],
      );
      expect(host).toHaveLength(2);
    }
    const { rows: columns } = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'task_execution_configs'
    `);
    expect(columns.map((column) => column.column_name)).not.toContain(
      "runtime_json",
    );
    expect(columns.map((column) => column.column_name)).not.toContain(
      "env_json",
    );
  }, 30_000);
});
