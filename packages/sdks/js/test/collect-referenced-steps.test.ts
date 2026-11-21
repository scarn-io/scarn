import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PIPELINE_BUILDER_DIR,
  collectDefinitionsFromDirectory,
  collectDefinitionsFromDirectoryTolerant,
} from "../src/push/collect-definitions";

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "scarn-referenced-steps-")));
}

async function collectionError(dir: string): Promise<string> {
  try {
    await collectDefinitionsFromDirectory(dir);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

const STEPS_URL = JSON.stringify(
  new URL("../src/definitions/steps/index.ts", import.meta.url).href,
);
const PIPELINES_URL = JSON.stringify(
  new URL("../src/pipelines/index.ts", import.meta.url).href,
);

const NOTION_TOOLS_SOURCE = `
import { defineMcp, mcpTool, mcpToolCatalog, z } from ${STEPS_URL};

export const notion = defineMcp({ type: "ref", name: "notion" }).withTools(
  mcpToolCatalog({
    source: { server: "notion" },
    tools: {
      search: mcpTool({ name: "search", input: z.object({ query: z.string() }) }),
      fetch: mcpTool({ name: "fetch", input: z.object({ id: z.string() }) }),
    },
  }),
);
`;

function searchPipelineSource(
  pipelineKey: string,
  stepExpression: string,
  imports: string,
): string {
  return `
import { definePipeline } from ${PIPELINES_URL};
${imports}

const search = ${stepExpression};

export default definePipeline({
  key: "${pipelineKey}",
  start: search({ query: "bugs" }),
  flow: [],
});
`;
}

describe("collectDefinitionsFromDirectory — steps referenced by pipelines", () => {
  test("publishes a tool step created inline in a pipeline, once", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "notion.ts"), NOTION_TOOLS_SOURCE);
      writeFileSync(
        join(dir, "search.ts"),
        searchPipelineSource(
          "search",
          "notion.tools.search.step()",
          `import { notion } from "./notion";`,
        ),
      );
      writeFileSync(
        join(dir, "search-again.ts"),
        searchPipelineSource(
          "search-again",
          "notion.tools.search.step()",
          `import { notion } from "./notion";`,
        ),
      );

      const collected = await collectDefinitionsFromDirectory(dir);
      const tolerant = await collectDefinitionsFromDirectoryTolerant(dir);

      expect(collected.steps.map((s) => s.key)).toEqual(["notion-search"]);
      expect(collected.steps[0]).toMatchObject({
        kind: "mcp_tool",
        toolCall: { server: "notion", tool: "search" },
      });
      expect(JSON.parse(JSON.stringify(collected.steps))).toEqual(
        collected.steps,
      );
      expect(tolerant.steps.map((s) => s.key)).toEqual(["notion-search"]);
      expect(tolerant.brokenPipelines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishes a tool step imported from a package outside the builder directory", async () => {
    const root = makeTempDir();
    try {
      const packageDir = join(root, "node_modules", "@acme", "notion-steps");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "@acme/notion-steps",
          type: "module",
          exports: "./index.js",
        }),
      );
      writeFileSync(
        join(packageDir, "index.js"),
        `${NOTION_TOOLS_SOURCE}\nexport const notionSearch = notion.tools.search.step();\nexport const notionFetch = notion.tools.fetch.step();\n`,
      );
      const builderDir = join(root, "builder");
      mkdirSync(builderDir);
      writeFileSync(
        join(builderDir, "search.ts"),
        searchPipelineSource(
          "search",
          "notionSearch",
          `import { notionSearch } from "@acme/notion-steps";`,
        ),
      );

      const collected = await collectDefinitionsFromDirectory(builderDir);

      expect(collected.steps.map((s) => s.key)).toEqual(["notion-search"]);
      expect(collected.steps[0]?.kind).toBe("mcp_tool");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dedupes a referenced step that is also exported, keeping the export", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "notion.ts"),
        `${NOTION_TOOLS_SOURCE}\nexport const notionSearch = notion.tools.search.step();\n`,
      );
      writeFileSync(
        join(dir, "search.ts"),
        searchPipelineSource(
          "search",
          "notionSearch.as('find')",
          `import { notionSearch } from "./notion";`,
        ),
      );

      const collected = await collectDefinitionsFromDirectory(dir);

      expect(collected.steps.map((s) => s.key)).toEqual(["notion-search"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails when two different specs share a key, naming both source sites", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "notion.ts"),
        `${NOTION_TOOLS_SOURCE}\nexport const notionSearch = notion.tools.search.step();\n`,
      );
      writeFileSync(
        join(dir, "search.ts"),
        searchPipelineSource(
          "search",
          `notion.tools.search.step({ name: "Another search" })`,
          `import { notion } from "./notion";`,
        ),
      );

      const message = await collectionError(dir);
      const tolerant = await collectDefinitionsFromDirectoryTolerant(dir);

      expect(message).toContain(
        'Step "notion-search" is defined twice with different specs',
      );
      expect(message).toContain('notion.ts (export "notionSearch")');
      expect(message).toContain('search.ts (pipeline "search")');
      expect(tolerant.steps.map((s) => s.key)).toEqual(["notion-search"]);
      expect(tolerant.brokenPipelines).toEqual([{ key: "search", message }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on an unexported code step, saying to export it", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "shout.ts"),
        searchPipelineSource(
          "shout",
          `codeStep({ key: "shout", name: "Shout", fn: (input) => input })`,
          `import { codeStep } from ${STEPS_URL};`,
        ),
      );

      const message = await collectionError(dir);

      expect(message).toContain(
        'Code step "shout" is used by shout.ts (pipeline "shout") but isn\'t exported',
      );
      expect(message).toContain("export it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("collects an exported code step a pipeline uses", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "shout.ts"),
        `
import { definePipeline } from ${PIPELINES_URL};
import { codeStep } from ${STEPS_URL};

export const shout = codeStep({ key: "shout", name: "Shout", fn: (input) => input });

export default definePipeline({ key: "shout", start: shout({}), flow: [] });
`,
      );

      const collected = await collectDefinitionsFromDirectory(dir);

      expect(collected.steps.map((s) => s.key)).toEqual(["shout"]);
      expect(collected.steps[0]?.entrypointJson).toEqual({
        sourceFile: join(PIPELINE_BUILDER_DIR, "shout.ts"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
