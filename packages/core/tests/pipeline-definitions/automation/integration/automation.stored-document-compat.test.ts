/**
 * Stored `automation_versions` rows stay readable as the automation document
 * schema evolves. Rows are written directly, bypassing publish, to stand in
 * for documents published by older code. See
 * `docs/persistence/json-columns.md`.
 */
import { beforeAll, describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { automationVersions } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { AutomationEntity } from "@/pipeline-definitions/automation/domain/automation-entity";
import type { StoredAutomationVersionColumns } from "@/pipeline-definitions/automation/contracts/automation-document-stored";
import { DrizzleAutomationRepo } from "@/pipeline-definitions/automation/infra/drizzle-automation-repo";
import { serialTest } from "tests/utils";
import v1Fixture from "../fixtures/v1.json";
import v1WithoutRuleKeysFixture from "../fixtures/v1-without-rule-keys.json";
import { createAutomationFixture } from "./automation-test-support";

const JSON_COLUMN_VERSIONING_MIGRATION = new URL(
  "../../../../drizzle/20261124214845_json_column_versioning/migration.sql",
  import.meta.url,
);

const readBackfillRuleKeysStatement = async (): Promise<string> => {
  const migration = await readFile(JSON_COLUMN_VERSIONING_MIGRATION, "utf8");
  const statement = migration
    .split("--> statement-breakpoint")
    .find((part) => part.includes('UPDATE "app"."automation_versions"'));
  if (!statement) {
    throw new Error("rule-key backfill statement not found in migration");
  }
  return statement;
};

const repo = new DrizzleAutomationRepo();

const insertAutomation = async (
  projectId: UuidV7,
  key: string,
  { document }: StoredAutomationVersionColumns,
  { enabled = false }: { enabled?: boolean } = {},
): Promise<UuidV7> => {
  const created = AutomationEntity.create({
    projectId,
    key,
    title: null,
    scope: "project",
  });
  await repo.insert(created);
  if (enabled) {
    await repo.update(created.setEnabled(true, new Date()));
  }
  await getDb().insert(automationVersions).values({
    id: createUuidV7(),
    automationId: created.id,
    version: 1,
    document,
    schemaVersion: 1,
    contentHash: "hash",
    publishedAt: new Date(),
  });
  return created.id;
};

const projectDocument = (
  key: string,
  rules: readonly Record<string, unknown>[],
) => ({
  kind: "automation",
  schemaVersion: 1,
  key,
  scope: "project",
  rules,
});

describe("automation stored document compatibility", () => {
  let projectId: UuidV7;

  beforeAll(async () => {
    ({ projectId } = await createAutomationFixture("stored-compat"));
  });

  serialTest("reads the v1 fixture through the repo", async () => {
    const automationId = await insertAutomation(
      projectId,
      v1Fixture.document.key,
      v1Fixture,
    );
    const version = await repo.loadLatestVersion(automationId);
    expect<object | undefined>(version?.document).toEqual(v1Fixture.document);
  });

  serialTest(
    "the backfill migration gives keyless rules the keys the reader does",
    async () => {
      const document = projectDocument(
        "keyless",
        v1WithoutRuleKeysFixture.document.rules.map((rule) => ({
          ...rule,
          event: "workItem.created",
        })),
      );
      const automationId = await insertAutomation(projectId, "keyless", {
        document,
      });
      const before = await repo.loadLatestVersion(automationId);

      await getDb().execute(
        sql.raw(await readBackfillRuleKeysStatement()),
      );

      const [row] = await getDb()
        .select({ document: automationVersions.document })
        .from(automationVersions)
        .where(eq(automationVersions.automationId, automationId));
      const rules = (row?.document as { rules: { key?: string }[] }).rules;
      expect(rules.map((rule) => rule.key)).toEqual([
        "rule-1",
        "rule-2",
        "rule-3",
      ]);
      const after = await repo.loadLatestVersion(automationId);
      expect<object | undefined>(after?.document).toEqual(before?.document);
    },
  );

  serialTest(
    "an unreadable version doesn't stop the project's other automations",
    async () => {
      await insertAutomation(
        projectId,
        "aa-unreadable",
        { document: { kind: "pipeline" } },
        {
          enabled: true,
        },
      );
      await insertAutomation(
        projectId,
        "zz-readable",
        {
          document: projectDocument("zz-readable", [
            {
              key: "on-create",
              event: "workItem.created",
              next: { routes: [{ kind: "skip" }] },
            },
          ]),
        },
        { enabled: true },
      );

      const resolved = await repo.listEnabledProjectAutomations(projectId);

      expect(
        resolved.map(({ automation, latestVersion }) => [
          automation.key,
          latestVersion?.document.key ?? null,
        ]),
      ).toEqual([
        ["aa-unreadable", null],
        ["zz-readable", "zz-readable"],
      ]);
    },
  );
});
