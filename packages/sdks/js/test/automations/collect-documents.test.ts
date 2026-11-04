/**
 * The built-document collector tells pipeline documents from automation
 * documents, and both share one key space.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectAutomationDocuments,
  collectBuiltDocuments,
  collectPipelineDocuments,
} from "@scarn/sdk/push";
import { wayfinder } from "./fixtures/wayfinder";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function builder(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "scarn-collect-documents-"));
  dirs.push(dir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(value));
  }
  return dir;
}

const pipeline = {
  schemaVersion: 1,
  key: "triage",
  start: { to: "plan" },
  nodes: { plan: { kind: "step", step: "plan" } },
};

describe("collectBuiltDocuments", () => {
  test("labels each document with its kind", () => {
    const dir = builder({
      "triage.json": pipeline,
      "wayfinder.json": wayfinder.document,
      "package.json": { name: "x" },
      "other.json": { hello: "world" },
    });

    expect(
      collectBuiltDocuments(dir).map(({ file, kind, key, title }) => ({
        file,
        kind,
        key,
        title,
      })),
    ).toEqual([
      {
        file: "triage.json",
        kind: "pipeline",
        key: "triage",
        title: undefined,
      },
      {
        file: "wayfinder.json",
        kind: "automation",
        key: "wayfinder",
        title: "Wayfinder",
      },
    ]);
    expect(collectPipelineDocuments(dir).map((file) => file.key)).toEqual([
      "triage",
    ]);
    expect(collectAutomationDocuments(dir)).toEqual([
      {
        file: "wayfinder.json",
        key: "wayfinder",
        title: "Wayfinder",
        document: wayfinder.document,
      },
    ]);
  });

  test("a pipeline and an automation can't share a key", () => {
    const dir = builder({
      "a.json": { ...pipeline, key: "wayfinder" },
      "wayfinder.json": wayfinder.document,
    });

    expect(() => collectPipelineDocuments(dir)).toThrow(
      'a.json and wayfinder.json are both "wayfinder"',
    );
  });

  test("an automation document needs a key", () => {
    const dir = builder({ "broken.json": { kind: "automation", rules: [] } });

    expect(() => collectAutomationDocuments(dir)).toThrow(
      'broken.json has no "key": every automation document names the automation it publishes to.',
    );
  });
});
