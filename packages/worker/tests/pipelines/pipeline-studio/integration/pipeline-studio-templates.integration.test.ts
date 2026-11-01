/**
 * The studio server's template endpoints, against a real `Bun.serve` and a
 * temp builder directory whose `node_modules` is the worker's own, so the
 * template previews and the snapshots behind the conflict checks run real
 * bun builds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runPipelineStudioServer,
  type PipelineStudioServerHandle,
} from "../../../../src/pipelines/pipeline-studio/application/run-pipeline-studio-server";
import type { PipelineTemplateCard } from "../../../../src/pipelines/pipeline-templates/application/list-pipeline-templates";
import type { PipelineTemplatePreview } from "../../../../src/pipelines/pipeline-templates/application/build-pipeline-template-preview";
import type { PipelineTemplateConflicts } from "../../../../src/pipelines/pipeline-templates/application/use-pipeline-template";

const WORKER_NODE_MODULES = resolve(
  import.meta.dir,
  "../../../../node_modules",
);
const INDEX_HTML = "<!doctype html><title>studio</title>";

type Studio = {
  handle: PipelineStudioServerHandle;
  builderDir: string;
  cleanup(): Promise<void>;
};

async function startStudio(): Promise<Studio> {
  const builderDir = mkdtempSync(join(tmpdir(), "scarn-studio-templates-"));
  symlinkSync(WORKER_NODE_MODULES, join(builderDir, "node_modules"), "dir");
  writeFileSync(join(builderDir, "bun.lock"), "");
  const staticDir = mkdtempSync(join(tmpdir(), "scarn-studio-static-"));
  writeFileSync(join(staticDir, "index.html"), INDEX_HTML);
  writeFileSync(join(staticDir, "main.js"), "console.log('studio');");
  const handle = await runPipelineStudioServer({
    builderDir,
    cliVersion: "9.9.9",
    staticDir,
  });
  return {
    handle,
    builderDir,
    cleanup: async () => {
      await handle.close();
      rmSync(builderDir, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

function useTemplate(
  studio: Studio,
  key: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${studio.handle.url}/api/templates/${key}/use`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: studio.handle.url,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function pipelineDocument(key: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    key,
    title: key,
    start: { to: "done" },
    nodes: { done: { kind: "succeed" } },
  });
}

type TemplateDetail = PipelineTemplateCard & {
  descriptionMarkdown: string;
  pipelineKey: string;
  stepKeys: string[];
  handoffSteps: { key: string; startedBy: string; summary: string }[];
  preview: PipelineTemplatePreview;
  conflicts: PipelineTemplateConflicts;
};

describe("pipeline studio template endpoints", () => {
  let studio: Studio;

  beforeAll(async () => {
    studio = await startStudio();
  });

  afterAll(async () => {
    await studio.cleanup();
  });

  test("GET /api/templates lists every template's card", async () => {
    const response = await fetch(`${studio.handle.url}/api/templates`);
    expect(response.status).toBe(200);
    const cards = (await response.json()) as (PipelineTemplateCard & {
      conflicts: PipelineTemplateConflicts;
    })[];
    const wayfinder = cards.find((card) => card.key === "wayfinder");
    expect(wayfinder).toMatchObject({
      name: "Wayfinder",
      stepCount: 4,
      handoffStepCount: 3,
      conflicts: {
        takenStepKeys: [],
        pipelineKeyTaken: false,
        nextPipelineKey: "wayfinder",
      },
    });
    expect(Object.keys(wayfinder ?? {}).sort()).toEqual([
      "conflicts",
      "handoffStepCount",
      "key",
      "name",
      "parameters",
      "stepCount",
      "summary",
      "tags",
    ]);
    expect(cards.map((card) => card.key)).toContain("web-repro-playwright");
  });

  test("GET /api/templates/:key returns the detail, a built preview and conflicts", async () => {
    const response = await fetch(
      `${studio.handle.url}/api/templates/wayfinder`,
    );
    expect(response.status).toBe(200);
    const detail = (await response.json()) as TemplateDetail;

    expect(detail.stepKeys).toEqual([
      "plan",
      "research",
      "prototype",
      "grilling",
    ]);
    expect(detail.handoffSteps.map((step) => step.key)).toEqual([
      "research",
      "prototype",
      "grilling",
    ]);
    expect(detail.descriptionMarkdown).toContain("Wayfinder");
    expect(detail.preview.errors).toEqual([]);

    const stepNodes = (detail.preview.pipeline?.nodes ?? []).filter(
      (node) => node.data.kind === "step",
    );
    expect(stepNodes.map((node) => node.data.stepKey)).toEqual(["plan"]);
    expect(detail.preview.steps.map((step) => step.key)).toEqual(
      detail.stepKeys,
    );
    const plan = detail.preview.steps.find((step) => step.key === "plan");
    expect(plan?.maxTurns).toBe(10);
    expect(plan?.workItemPermissions).toEqual(["children"]);
    expect(plan?.repo).toEqual({ mode: "readOnly" });
    expect(plan?.prompt).toBeTruthy();

    expect(detail.conflicts).toEqual({
      takenStepKeys: [],
      pipelineKeyTaken: false,
      nextPipelineKey: "wayfinder",
    });
  }, 60_000);

  test("GET /api/templates/:key is 404 for an unknown template", async () => {
    const response = await fetch(`${studio.handle.url}/api/templates/nope`);
    expect(response.status).toBe(404);
  });

  test("POST use writes the file, then refuses a second use on step collisions", async () => {
    const first = await useTemplate(studio, "wayfinder", {
      parameterValues: { planning_guidance: 'Keep it "small" `${x}`' },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      file: "wayfinder.ts",
      pipelineKey: "wayfinder",
    });
    const written = readFileSync(
      join(studio.builderDir, "wayfinder.ts"),
      "utf8",
    );
    expect(written).toContain("pipeline template (scarn 9.9.9)");
    expect(written).toContain(
      `const PLANNING_GUIDANCE = ${JSON.stringify('Keep it "small" `${x}`')};`,
    );

    const second = await useTemplate(studio, "wayfinder", {});
    expect(second.status).toBe(409);
    const body = (await second.json()) as { takenStepKeys: string[] };
    expect(body.takenStepKeys).toEqual([
      "plan",
      "research",
      "prototype",
      "grilling",
    ]);
    expect(existsSync(join(studio.builderDir, "wayfinder-2.ts"))).toBe(false);

    const detail = (await (
      await fetch(`${studio.handle.url}/api/templates/wayfinder`)
    ).json()) as TemplateDetail;
    expect(detail.conflicts.pipelineKeyTaken).toBe(true);

    const cards = (await (
      await fetch(`${studio.handle.url}/api/templates`)
    ).json()) as { key: string; conflicts: PipelineTemplateConflicts }[];
    expect(
      cards.find((card) => card.key === "wayfinder")?.conflicts,
    ).toMatchObject({ pipelineKeyTaken: true, nextPipelineKey: "wayfinder-2" });
  }, 60_000);

  test("POST use numbers the pipeline key past the highest taken suffix", async () => {
    writeFileSync(
      join(studio.builderDir, "web-repro-playwright.json"),
      pipelineDocument("web-repro-playwright"),
    );
    writeFileSync(
      join(studio.builderDir, "web-repro-playwright-3.json"),
      pipelineDocument("web-repro-playwright-3"),
    );
    const response = await useTemplate(studio, "web-repro-playwright", {
      parameterValues: { app_access_instructions: "Open http://localhost" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      file: "web-repro-playwright-4.ts",
      pipelineKey: "web-repro-playwright-4",
    });
    const written = readFileSync(
      join(studio.builderDir, "web-repro-playwright-4.ts"),
      "utf8",
    );
    expect(written).toContain('key: "web-repro-playwright-4",');
  }, 60_000);

  test("POST use is 422 for a missing required or an unknown parameter", async () => {
    const missing = await useTemplate(studio, "web-repro-playwright", {
      parameterValues: {},
    });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({
      missingParameters: ["app_access_instructions"],
    });

    const unknown = await useTemplate(studio, "web-repro-playwright", {
      parameterValues: { app_access_instructions: "x", surprise: "y" },
    });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({
      unknownParameters: ["surprise"],
    });
  }, 30_000);

  test("POST use rejects a foreign or missing Origin and a non-JSON body", async () => {
    const foreign = await useTemplate(
      studio,
      "wayfinder",
      {},
      { Origin: "http://evil.example" },
    );
    expect(foreign.status).toBe(403);

    const noOrigin = await fetch(
      `${studio.handle.url}/api/templates/wayfinder/use`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(noOrigin.status).toBe(403);

    const formPost = await fetch(
      `${studio.handle.url}/api/templates/wayfinder/use`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: studio.handle.url,
        },
        body: "{}",
      },
    );
    expect(formPost.status).toBe(415);
  });

  test("serves index.html for client-side routes, but not for /api or asset paths", async () => {
    const route = await fetch(`${studio.handle.url}/templates/wayfinder`);
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toContain("text/html");
    expect(await route.text()).toBe(INDEX_HTML);

    const asset = await fetch(`${studio.handle.url}/main.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const missingAsset = await fetch(`${studio.handle.url}/missing.js`);
    expect(missingAsset.status).toBe(404);

    const api = await fetch(`${studio.handle.url}/api/nope`);
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
  });
});
