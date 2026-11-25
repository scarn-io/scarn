import { describe, expect } from "bun:test";
import { automationDocumentSchema } from "@scarn/sdk/contracts/automation-document";
import {
  CURRENT_AUTOMATION_DOCUMENT_SCHEMA_VERSION,
  readStoredAutomationDocument,
  type StoredAutomationVersionColumns,
} from "@/pipeline-definitions/automation/contracts/automation-document-stored";
import { automationVersionFromRow } from "@/pipeline-definitions/automation/infra/drizzle-automation-repo";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import v1Fixture from "../fixtures/v1.json";
import v1WithoutRuleKeysFixture from "../fixtures/v1-without-rule-keys.json";

const versionRow = (
  schemaVersion: number,
  { document }: StoredAutomationVersionColumns,
) => ({
  id: createUuidV7(),
  automationId: createUuidV7(),
  version: 1,
  document,
  schemaVersion,
  contentHash: "hash",
  publishedAt: new Date("2026-11-01T00:00:00.000Z"),
});

describe("automation document stored read", () => {
  concurrentTest("reads the v1 fixture as stored", () => {
    const read = readStoredAutomationDocument(
      v1Fixture.schemaVersion,
      v1Fixture,
    );
    if (!read.success) throw new Error(read.reason);
    expect<object>(read.value).toEqual(v1Fixture.document);
  });

  concurrentTest("the v1 fixture still passes the publish schema", () => {
    expect(automationDocumentSchema.safeParse(v1Fixture.document).success).toBe(
      true,
    );
  });

  concurrentTest("reads the v1 fixture through the row mapper", () => {
    const version = automationVersionFromRow(
      versionRow(v1Fixture.schemaVersion, v1Fixture),
    );
    expect<object>(version.document).toEqual(v1Fixture.document);
  });

  concurrentTest("gives rules published without keys rule-<n> keys", () => {
    const read = readStoredAutomationDocument(
      v1WithoutRuleKeysFixture.schemaVersion,
      v1WithoutRuleKeysFixture,
    );
    if (!read.success) throw new Error(read.reason);
    expect(read.value.rules.map((rule) => rule.key)).toEqual([
      "rule-1",
      "rule-2",
      "rule-3",
    ]);
    expect<object>(read.value).toEqual({
      ...v1WithoutRuleKeysFixture.document,
      rules: v1WithoutRuleKeysFixture.document.rules.map((rule, index) => ({
        ...rule,
        key: `rule-${String(index + 1)}`,
      })),
    });
  });

  concurrentTest("keeps the keys of rules that have them", () => {
    const [first, second] = v1WithoutRuleKeysFixture.document.rules;
    const read = readStoredAutomationDocument(1, {
      document: {
        ...v1WithoutRuleKeysFixture.document,
        rules: [first, { ...second, key: "route-ready-children" }],
      },
    });
    if (!read.success) throw new Error(read.reason);
    expect(read.value.rules.map((rule) => rule.key)).toEqual([
      "rule-1",
      "route-ready-children",
    ]);
  });

  concurrentTest(
    "does not reapply publish rules (bad rule key, scope mismatch, bad cron)",
    () => {
      const read = readStoredAutomationDocument(1, {
        document: {
          kind: "automation",
          schemaVersion: 1,
          key: "loose",
          scope: "workItem",
          rules: [
            {
              key: "has spaces",
              event: "workItem.created",
              next: { routes: [{ kind: "step", to: "plan", on: "workItem" }] },
            },
            {
              key: "has spaces",
              event: "schedule",
              cron: "not a cron",
              timezone: "Mars/Olympus",
              next: { routes: [{ kind: "step", to: "plan" }] },
            },
          ],
        },
      });
      expect(read.success).toBe(true);
    },
  );

  concurrentTest("strips keys that are no longer part of the shape", () => {
    const read = readStoredAutomationDocument(1, {
      document: { ...v1Fixture.document, retired: true },
    });
    if (!read.success) throw new Error(read.reason);
    expect(read.value).not.toHaveProperty("retired");
  });

  concurrentTest("rejects an unknown schema version", () => {
    const read = readStoredAutomationDocument(
      CURRENT_AUTOMATION_DOCUMENT_SCHEMA_VERSION + 1,
      v1Fixture,
    );
    expect(read.success).toBe(false);
  });

  concurrentTest("rejects a structurally broken document", () => {
    const read = readStoredAutomationDocument(1, {
      document: {
        kind: "automation",
        schemaVersion: 1,
        key: "broken",
        scope: "workItem",
        rules: [{ event: "self.attached" }],
      },
    });
    expect(read.success).toBe(false);
  });

  concurrentTest("the row mapper fails on an unreadable document", () => {
    expect(() =>
      automationVersionFromRow(
        versionRow(1, { document: { kind: "pipeline" } }),
      ),
    ).toThrow(/unreadable/);
  });
});
