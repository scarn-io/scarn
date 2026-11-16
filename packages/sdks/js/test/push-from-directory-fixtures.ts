/** The mock server and builder-directory fixtures shared by the push tests. */

export const AUTHORED_ENVIRONMENTS_JS = `
import { defineStep, Runtime } from ${JSON.stringify(new URL("../src/definitions/steps/index.ts", import.meta.url).href)};
export const first = defineStep({
  key: "named-first", name: "Named first", environment: "shared-build",
  agentPrompt: "Build the app",
});
export const second = defineStep({
  key: "named-second", name: "Named second", environment: "shared-build",
  agentPrompt: "Test the app",
});
export const inline = defineStep({
  key: "inline", name: "Inline", environment: { runtime: Runtime.managed.bun1() },
  agentPrompt: "Check the app",
});
export const defaultStep = defineStep({
  key: "default", name: "Default", agentPrompt: "Review the app",
});
`;

const ENVIRONMENTS_ENTRY = JSON.stringify(
  new URL("../src/definitions/environments/index.ts", import.meta.url).href,
);
const STEPS_ENTRY = JSON.stringify(
  new URL("../src/definitions/steps/index.ts", import.meta.url).href,
);

/** An exported environment, re-exported under a second name. */
export const FRONTEND_ENVIRONMENT_JS = `
import { defineEnvironment, Runtime } from ${ENVIRONMENTS_ENTRY};
export const frontend = defineEnvironment({
  name: "frontend",
  runtime: Runtime.managed.bun1(),
  vars: { NODE_ENV: "development" },
});
export const frontendAgain = frontend;
`;

/**
 * Steps using the exported `frontend`, an environment no file exports, and a
 * string name.
 */
export const HANDLE_STEPS_JS = (stringName: string) => `
import { defineEnvironment } from ${ENVIRONMENTS_ENTRY};
import { defineStep } from ${STEPS_ENTRY};
import { frontend } from "./environments.js";
const hidden = defineEnvironment({ name: "hidden", description: "develop" });
export const fixUi = defineStep({
  key: "fix-ui", name: "Fix UI", environment: frontend, agentPrompt: "Fix it",
});
export const useHidden = defineStep({
  key: "use-hidden", name: "Use hidden", environment: hidden, agentPrompt: "Go",
});
export const byName = defineStep({
  key: "by-name", name: "By name", environment: ${JSON.stringify(stringName)},
  agentPrompt: "Go",
});
`;

/** A second, different `frontend`. */
export const CONFLICTING_FRONTEND_JS = `
import { defineEnvironment } from ${ENVIRONMENTS_ENTRY};
export const otherFrontend = defineEnvironment({ name: "frontend", description: "main" });
`;

export type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
};

export async function readRequest(
  input: string | URL | Request,
): Promise<CapturedRequest> {
  const req = input as Request;
  const text = await req.clone().text();
  return {
    url: req.url,
    method: req.method,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}

export const BASE_URL = "https://scarn.example.com";

export function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type ServerPipeline = {
  id: string;
  key: string;
  versions: string[];
};

/**
 * Mock fetch that records every request and keeps just enough server state
 * for a push: upserted steps, and pipelines whose versions are compared by
 * serialized document, the way the server compares content hashes.
 */
export function makeMockFetch(
  captured: CapturedRequest[],
  options: { serverEnvironments?: readonly string[] } = {},
): typeof globalThis.fetch {
  const upsertedSteps: Array<{ id: string; key: string; version: number }> = [];
  const pipelines: ServerPipeline[] = [];
  const automations = new Map<string, string[]>();
  const environments = new Map<string, string[]>(
    (options.serverEnvironments ?? []).map((name) => [name, ["{}"]]),
  );
  let nextId = 1;

  const environmentContract = (name: string) => ({
    id: `env-${name}`,
    projectId: "proj",
    name,
    description: null,
    latestVersion: environments.get(name)?.length ?? 0,
    updatedBy: { userId: "user-1", username: null },
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const versionContract = (pipeline: ServerPipeline) => ({
    id: `${pipeline.id}-v${String(pipeline.versions.length)}`,
    pipelineDefinitionId: pipeline.id,
    version: pipeline.versions.length,
  });
  const pipelineContract = (pipeline: ServerPipeline) => ({
    id: pipeline.id,
    key: pipeline.key,
    currentVersion: versionContract(pipeline),
  });

  return (async (input: string | URL | Request) => {
    const req = await readRequest(input);
    captured.push(req);
    const path = new URL(req.url).pathname;

    if (req.method === "GET" && path === "/api/step-definitions") {
      return json(upsertedSteps);
    }
    if (req.method === "PUT" && path === "/api/step-definitions") {
      const body = req.body as { key: string; version: number };
      const id = `step-${String(nextId++)}`;
      upsertedSteps.push({ id, key: body.key, version: body.version });
      return json({ id, key: body.key, version: body.version });
    }
    if (req.method === "GET" && path.endsWith("/pipeline-definitions")) {
      return json(pipelines.map(pipelineContract));
    }
    if (req.method === "POST" && path === "/api/pipeline-definitions") {
      const body = req.body as { key: string; document: unknown };
      const pipeline: ServerPipeline = {
        id: `pipe-${String(nextId++)}`,
        key: body.key,
        versions: [JSON.stringify(body.document)],
      };
      pipelines.push(pipeline);
      return json(pipelineContract(pipeline));
    }
    const versions = /^\/api\/pipeline-definitions\/([^/]+)\/versions$/.exec(
      path,
    );
    if (req.method === "POST" && versions) {
      const pipeline = pipelines.find((p) => p.id === versions[1]);
      if (!pipeline) return json({ title: "Not found" }, 404);
      const document = JSON.stringify(
        (req.body as { document: unknown }).document,
      );
      const published = pipeline.versions.at(-1) !== document;
      if (published) pipeline.versions.push(document);
      return json({
        published,
        version: versionContract(pipeline),
        pipelineDefinition: pipelineContract(pipeline),
      });
    }
    const automation = /^\/api\/projects\/[^/]+\/automations\/([^/]+)$/.exec(
      path,
    );
    if (req.method === "PUT" && automation) {
      const key = automation[1] ?? "";
      const versions = automations.get(key) ?? [];
      const document = JSON.stringify(
        (req.body as { document: unknown }).document,
      );
      const published = versions.at(-1) !== document;
      if (published) versions.push(document);
      automations.set(key, versions);
      return json({
        published,
        automation: {
          id: `auto-${key}`,
          key,
          enabled: false,
          latestVersion: { version: versions.length },
        },
      });
    }
    if (
      req.method === "GET" &&
      /^\/api\/projects\/[^/]+\/environments$/.test(path)
    ) {
      return json([...environments.keys()].map(environmentContract));
    }
    const environment = /^\/api\/projects\/[^/]+\/environments\/([^/]+)$/.exec(
      path,
    );
    if (req.method === "PUT" && environment) {
      const name = environment[1] ?? "";
      const content = (req.body as { content: unknown }).content;
      const versions = environments.get(name) ?? [];
      const serialized = JSON.stringify(content);
      const published = versions.at(-1) !== serialized;
      if (published) versions.push(serialized);
      environments.set(name, versions);
      return json({
        environment: environmentContract(name),
        version: {
          id: `env-${name}-v${String(versions.length)}`,
          environmentId: `env-${name}`,
          version: versions.length,
          content,
          contentHash: serialized,
          createdBy: { userId: "user-1", username: null },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        published,
      });
    }
    if (req.method === "GET") {
      return json([]);
    }
    return json({ id: "x" });
  }) as unknown as typeof globalThis.fetch;
}

export const STEP_A_JS = `
export const stepA = {
  key: "step-a",
  name: "Step A",
  description: null,
  version: 1,
  kind: "user_defined",
  status: "active",
  prompt: null,
  inputSchemaJson: null,
  resultSchemaJson: null,
  opencodeMcpJson: null,
};
`;

export const STEP_AND_PIPELINE_JS = (key: string) => `
${STEP_A_JS}
export default {
  key: ${JSON.stringify(key)},
  name: ${JSON.stringify(key)},
  start: "step-a",
  nodes: { "step-a": { type: "step", step: "step-a" } },
};
`;

export const PIPELINE_DOCUMENT = (key: string, title: string) => ({
  schemaVersion: 1,
  key,
  title,
  start: { node: "a" },
  nodes: { a: { kind: "step", step: "step-a" } },
});
