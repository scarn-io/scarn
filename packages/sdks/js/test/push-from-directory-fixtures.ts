/** The mock server and builder-directory fixtures shared by the push tests. */

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
): typeof globalThis.fetch {
  const upsertedSteps: Array<{ id: string; key: string; version: number }> = [];
  const pipelines: ServerPipeline[] = [];
  const automations = new Map<string, string[]>();
  let nextId = 1;

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
