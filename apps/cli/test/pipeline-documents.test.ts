import { describe, expect, test } from "bun:test";
import { CliError } from "../src/lib/cli-error";
import {
  activeVersionOf,
  buildStepCatalog,
  formatDocumentIssues,
  parsePipelineDocumentText,
  validatePipelineDocument,
  type CatalogStepDefinition,
} from "../src/lib/pipeline-documents";

const objectSchema = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
});

function step(
  overrides: Partial<CatalogStepDefinition> & { key: string },
): CatalogStepDefinition {
  return {
    version: 1,
    status: "active",
    inputSchemaJson: objectSchema({}),
    resultSchemaJson: objectSchema({}),
    errors: [],
    ...overrides,
  };
}

const document = () => ({
  schemaVersion: 1,
  key: "triage",
  start: { to: "summarize" },
  nodes: {
    summarize: {
      kind: "step",
      step: "summarize",
      next: {
        routes: [{ to: "done" }],
      },
    },
    done: { kind: "succeed" },
  },
});

describe("parsePipelineDocumentText", () => {
  test("reads the key and title of a document", () => {
    const parsed = parsePipelineDocumentText(
      "triage.json",
      JSON.stringify({ ...document(), title: "Triage" }),
    );

    expect(parsed.key).toBe("triage");
    expect(parsed.title).toBe("Triage");
    expect(parsed.document["nodes"]).toEqual(document().nodes);
  });

  test("rejects invalid JSON, non-objects and documents without a key", () => {
    for (const text of ["{", "[]", JSON.stringify({ schemaVersion: 1 })]) {
      expect(() => parsePipelineDocumentText("bad.json", text)).toThrow(
        CliError,
      );
    }
  });
});

describe("buildStepCatalog", () => {
  test("keeps the latest active version of each key, as the server pins", () => {
    const catalog = buildStepCatalog([
      step({ key: "summarize", version: 1, errors: ["Old"] }),
      step({ key: "summarize", version: 3, errors: ["Latest"] }),
      step({
        key: "summarize",
        version: 4,
        status: "draft",
        errors: ["Draft"],
      }),
      step({ key: "retired", status: "archived" }),
    ]);

    expect(Object.keys(catalog)).toEqual(["summarize"]);
    expect(catalog["summarize"]?.errors).toEqual(["Latest"]);
  });
});

describe("validatePipelineDocument", () => {
  test("accepts a document whose steps exist in the project", () => {
    const result = validatePipelineDocument(document(), [
      step({ key: "summarize" }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("reports a step the project has no active definition for, by path", () => {
    const result = validatePipelineDocument(document(), [
      step({ key: "summarize", status: "draft" }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toContain(
      "/nodes/summarize/step",
    );
  });
});

describe("formatDocumentIssues", () => {
  test("prints the path, message and hint on one line", () => {
    expect(
      formatDocumentIssues([
        {
          path: "/nodes/fix/next/routes/1/args/plan",
          message: "missing",
          hint: 'Did you mean "input.plan"?',
        },
        { path: "", message: "bad" },
      ]),
    ).toEqual([
      '/nodes/fix/next/routes/1/args/plan: missing. Did you mean "input.plan"?',
      "/: bad",
    ]);
  });
});

describe("activeVersionOf", () => {
  test("reads the active version's number and definition", () => {
    expect(
      activeVersionOf({
        currentVersion: { version: 2, definition: document(), steps: [] },
      }),
    ).toEqual({ version: 2, definition: document() });
  });

  test("is undefined for a pipeline with no published version", () => {
    expect(activeVersionOf({ currentVersion: null })).toBeUndefined();
  });
});
