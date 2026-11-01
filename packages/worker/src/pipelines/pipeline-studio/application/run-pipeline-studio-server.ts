// The local server behind `scarn pipelines studio`: `Bun.serve` serving the
// built `@scarn/pipeline-studio-ui` static assets (and `index.html` for any
// other non-API path, so client-side routes survive a reload), plus:
//
// - `GET /api/stream`: SSE that pushes a fresh `StudioSnapshot` (see
//   `compute-studio-snapshot.ts`) every time `.scarn/pipeline-builder`
//   changes on disk.
// - `GET /api/templates` and `GET /api/templates/:key`: the pipeline
//   templates the CLI ships, each with the name conflicts a "Use" would hit
//   (and, on the detail, a built preview).
// - `POST /api/templates/:key/use`: writes the template's `<pipelineKey>.ts`
//   into the builder directory (see `use-pipeline-template.ts`). This is the
//   server's only write path, so the server binds to 127.0.0.1 and rejects
//   requests whose `Host` or `Origin` isn't its own origin.
//
// Watches with Node's built-in `fs.watch` rather than adding `chokidar` as a
// new direct dependency: `chokidar` already appears in `bun.lock`, but only
// as a TRANSITIVE dependency of unrelated tools (`@astrojs/check`, `c12`),
// never a direct dependency of any workspace package — so using it here
// would still be a brand-new direct dependency, and the builder directory
// this watches is flat (`collect-definitions.ts`'s own `readdirSync` never
// recurses), which is exactly the case `fs.watch` handles without caveats.
import { existsSync, watch } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  computeStudioState,
  type StudioState,
} from "./compute-studio-snapshot";
import { COLLECT_SCRIPT_FILENAME } from "../infra/collect-script";
import type { StudioSnapshot } from "@scarn/pipeline-studio-ui";
import { createLazyLogger } from "@scarn/observability/logging/host";
import {
  buildPipelineDocuments,
  listPipelineSourceFiles,
} from "../../pipeline-definitions/application/build-pipeline-documents";
import { BUILD_SCRIPT_FILENAME } from "../../pipeline-definitions/infra/build-script";
import {
  createPipelineTemplatePreviewCache,
  type PipelineTemplatePreviewCache,
} from "../../pipeline-templates/application/build-pipeline-template-preview";
import {
  describePipelineTemplate,
  findPipelineTemplate,
  listPipelineTemplates,
  toPipelineTemplateCard,
} from "../../pipeline-templates/application/list-pipeline-templates";
import {
  checkPipelineTemplateConflicts,
  usePipelineTemplate,
  type ExistingBuilderDefinitions,
} from "../../pipeline-templates/application/use-pipeline-template";

const logger = createLazyLogger({
  name: "@scarn/worker",
  scope: "pipeline-studio",
});

/**
 * Rebuilds the JSON of the changed `.ts` pipeline sources. Build and
 * validation errors aren't surfaced here: a source that fails to import is
 * already shown as broken by the snapshot's own collection, and the written
 * JSON is validated when it renders.
 */
async function rebuildPipelineSources(
  builderDir: string,
  filenames: readonly string[],
): Promise<void> {
  const candidates = new Set(listPipelineSourceFiles(builderDir));
  const files = filenames
    .map((file) => join(builderDir, file))
    .filter((file) => candidates.has(file));
  if (files.length === 0) return;
  try {
    await buildPipelineDocuments({ builderDir, files });
  } catch (error) {
    logger.warn({ err: error }, "Failed to rebuild pipeline JSON");
  }
}

const DEBOUNCE_MS = 150;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export type PipelineStudioServerHandle = {
  /** The local URL the browser should be opened to. */
  readonly url: string;
  /** Stops the file watcher and the HTTP server. */
  close(): Promise<void>;
};

export type RunPipelineStudioServerOptions = {
  /** Absolute path to `.scarn/pipeline-builder`. */
  builderDir: string;
  /** Named in the provenance header of files written from templates. */
  cliVersion: string;
  /** Fixed port, or omit to let the OS pick a free one. */
  port?: number;
  /** Directory holding the built studio assets; defaults to `@scarn/pipeline-studio-ui`'s `dist/`. */
  staticDir?: string;
};

export const MISSING_STUDIO_ASSETS_MESSAGE =
  "Pipeline studio assets are missing. Run `bun run --filter @scarn/pipeline-studio-ui build`.";

/**
 * Resolves `@scarn/pipeline-studio-ui`'s own `dist/` directory. Two cases:
 *
 * - Inside a compiled binary (`Bun.isStandaloneExecutable`): there's no
 *   `node_modules` to resolve against. `apps/cli`'s `bun build --compile`
 *   step embeds that `dist/` via `--asset=`, and `import.meta.dir` collapses
 *   to the same bundle root (`/$bunfs/root`) for every module in a compiled
 *   binary, not just the entrypoint — so `join(import.meta.dir, "dist")`
 *   finds it regardless of how deep this file lives inside `packages/worker`.
 * - Otherwise (source checkout / `bun run`): normal package resolution via
 *   `@scarn/pipeline-studio-ui/package.json`, which requires that package
 *   to expose `"./package.json"` in its `exports` map — see its
 *   `package.json`.
 */
function resolveStaticDir(): string {
  if (Bun.isStandaloneExecutable) {
    return join(import.meta.dir, "dist");
  }
  const pkgJsonPath = Bun.resolveSync(
    "@scarn/pipeline-studio-ui/package.json",
    import.meta.dir,
  );
  return join(dirname(pkgJsonPath), "dist");
}

/** Guards against `../` escaping `staticDir`, however unlikely from a fixed asset set. */
function resolveStaticAsset(
  staticDir: string,
  pathname: string,
): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = resolve(staticDir, relative);
  if (resolved !== staticDir && !resolved.startsWith(staticDir + sep)) {
    return null;
  }
  return resolved;
}

/**
 * Serves a built asset. A path with no file extension is a client-side route
 * (`/templates/wayfinder`), so it gets `index.html`; a missing asset is a 404.
 */
function serveStaticAsset(staticDir: string, pathname: string): Response {
  const filePath = resolveStaticAsset(
    staticDir,
    extname(pathname) === "" ? "/" : pathname,
  );
  if (!filePath || !existsSync(filePath)) {
    return new Response(
      "Not found. Run `bun run --filter @scarn/pipeline-studio-ui build` " +
        "first if you're running this from a source checkout.",
      { status: 404 },
    );
  }
  const contentType =
    CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": contentType },
  });
}

/** One connected browser tab's SSE stream. */
type SseClient = {
  enqueue(bytes: Uint8Array): void;
};

function encodeSnapshot(snapshot: StudioSnapshot): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(snapshot)}\n\n`);
}

function buildStreamResponse(
  currentSnapshot: () => StudioSnapshot,
  clients: Set<SseClient>,
): Response {
  let client: SseClient | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        enqueue: (bytes) => {
          controller.enqueue(bytes);
        },
      };
      clients.add(client);
      controller.enqueue(encodeSnapshot(currentSnapshot()));
    },
    cancel() {
      if (client) clients.delete(client);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function jsonError(status: number, message: string, extra?: object): Response {
  return Response.json({ error: message, ...extra }, { status });
}

function existingDefinitions(state: StudioState): ExistingBuilderDefinitions {
  return {
    stepKeys: state.steps.map((step) => step.key),
    pipelineKeys:
      state.snapshot.status === "ok"
        ? state.snapshot.pipelines.map((pipeline) => pipeline.key)
        : [],
  };
}

/**
 * Rejects a request that didn't come from the studio page itself: its `Host`
 * must be this server (guards against DNS rebinding), and its `Origin`, which
 * browsers send on every cross-origin and every POST request, must be too.
 */
function isSameOrigin(request: Request, port: number): boolean {
  const allowedHosts = [
    `127.0.0.1:${String(port)}`,
    `localhost:${String(port)}`,
  ];
  const host = request.headers.get("host");
  if (host === null || !allowedHosts.includes(host)) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return request.method === "GET";
  return allowedHosts.some((allowed) => origin === `http://${allowed}`);
}

type TemplateRouteContext = {
  builderDir: string;
  cliVersion: string;
  previews: PipelineTemplatePreviewCache;
  currentState: () => StudioState;
};

async function handleTemplateDetail(
  key: string,
  context: TemplateRouteContext,
): Promise<Response> {
  const template = findPipelineTemplate(key);
  if (!template) return jsonError(404, `No pipeline template "${key}".`);
  const preview = await context.previews.get(template);
  return Response.json({
    ...describePipelineTemplate(template),
    preview,
    conflicts: checkPipelineTemplateConflicts(
      template,
      context.builderDir,
      existingDefinitions(context.currentState()),
    ),
  });
}

async function handleUseTemplate(
  key: string,
  request: Request,
  context: TemplateRouteContext,
): Promise<Response> {
  const template = findPipelineTemplate(key);
  if (!template) return jsonError(404, `No pipeline template "${key}".`);
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return jsonError(415, "Content-Type must be application/json.");
  }
  const body = useTemplateBodySchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!body.success) {
    return jsonError(
      422,
      "The request body must be `{ parameterValues: { [key]: string } }`.",
      { missingParameters: [], unknownParameters: [] },
    );
  }
  const state = await computeStudioState(context.builderDir);
  if (state.snapshot.status === "error") {
    return jsonError(
      503,
      `The pipeline builder directory couldn't be read: ${state.snapshot.message}`,
    );
  }
  const result = usePipelineTemplate(template, {
    builderDir: context.builderDir,
    cliVersion: context.cliVersion,
    parameterValues: body.data.parameterValues,
    existing: existingDefinitions(state),
  });
  if (result.ok) {
    return Response.json({
      file: result.file,
      pipelineKey: result.pipelineKey,
    });
  }
  if (result.reason === "step-keys-taken") {
    return jsonError(409, result.message, {
      takenStepKeys: result.takenStepKeys,
    });
  }
  return jsonError(422, result.message, {
    missingParameters: result.missingParameters,
    unknownParameters: result.unknownParameters,
  });
}

const useTemplateBodySchema = z.object({
  parameterValues: z.record(z.string(), z.string()).default({}),
});

const TEMPLATE_DETAIL_PATH = /^\/api\/templates\/([^/]+)$/;
const TEMPLATE_USE_PATH = /^\/api\/templates\/([^/]+)\/use$/;

async function handleApiRequest(
  request: Request,
  pathname: string,
  context: TemplateRouteContext,
): Promise<Response> {
  const isGet = request.method === "GET" || request.method === "HEAD";
  if (pathname === "/api/templates") {
    if (!isGet) return jsonError(405, "Method not allowed.");
    const existing = existingDefinitions(context.currentState());
    return Response.json(
      listPipelineTemplates().map((template) => ({
        ...toPipelineTemplateCard(template),
        conflicts: checkPipelineTemplateConflicts(
          template,
          context.builderDir,
          existing,
        ),
      })),
    );
  }
  const useMatch = TEMPLATE_USE_PATH.exec(pathname);
  if (useMatch) {
    if (request.method !== "POST") return jsonError(405, "Method not allowed.");
    return handleUseTemplate(
      decodeURIComponent(useMatch[1] ?? ""),
      request,
      context,
    );
  }
  const detailMatch = TEMPLATE_DETAIL_PATH.exec(pathname);
  if (detailMatch) {
    if (!isGet) return jsonError(405, "Method not allowed.");
    return handleTemplateDetail(
      decodeURIComponent(detailMatch[1] ?? ""),
      context,
    );
  }
  return jsonError(404, "Not found.");
}

/**
 * Starts the studio's HTTP server and file watcher. Runs one immediate
 * `computeStudioSnapshot` before returning, so the very first browser
 * request already has real content instead of an empty "connecting" state.
 *
 * Throws before binding a port or starting the watcher when the built assets
 * are missing, so callers never open a browser onto a page of 404s.
 */
export async function runPipelineStudioServer(
  options: RunPipelineStudioServerOptions,
): Promise<PipelineStudioServerHandle> {
  const { builderDir, cliVersion } = options;
  const staticDir = options.staticDir ?? resolveStaticDir();
  if (!existsSync(join(staticDir, "index.html"))) {
    throw new Error(MISSING_STUDIO_ASSETS_MESSAGE);
  }
  const clients = new Set<SseClient>();

  let state = await computeStudioState(builderDir);

  function broadcast(): void {
    const bytes = encodeSnapshot(state.snapshot);
    for (const client of clients) client.enqueue(bytes);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // The collect script (compiled-binary mode only) is written at most once
  // per builderDir, idempotent-if-missing — see
  // `collect-definitions-via-subprocess.ts`. Without this guard, that
  // one-time write would still fire this watcher and trigger one harmless
  // but wasteful extra recompute; `filename === null` (platform-dependent)
  // is treated as "always recompute" rather than skipped, since it can't be
  // attributed to the collect script specifically.
  //
  // A changed `.ts` file is rebuilt to its `<key>.json` first (see
  // `rebuildPipelineSource`); the JSON write fires this watcher again, and
  // that event renders it.
  const changedSources = new Set<string>();
  const watcher = watch(
    builderDir,
    { persistent: true },
    (_event, filename) => {
      if (filename === COLLECT_SCRIPT_FILENAME) return;
      if (filename === BUILD_SCRIPT_FILENAME) return;
      if (filename?.endsWith(".tmp")) return;
      if (filename?.endsWith(".ts")) changedSources.add(filename);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const sources = [...changedSources];
        changedSources.clear();
        void rebuildPipelineSources(builderDir, sources)
          .then(() => computeStudioState(builderDir))
          .then((next) => {
            state = next;
            broadcast();
          });
      }, DEBOUNCE_MS);
    },
  );

  const context: TemplateRouteContext = {
    builderDir,
    cliVersion,
    previews: createPipelineTemplatePreviewCache({ builderDir, cliVersion }),
    currentState: () => state,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    // `/api/stream` is a long-lived SSE response that is silent between
    // file changes; Bun's default 10s idle timeout would cut it.
    idleTimeout: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (!isSameOrigin(request, server.port ?? 0)) {
        return jsonError(
          403,
          "Requests must come from the studio's own origin.",
        );
      }
      if (pathname === "/api/stream") {
        return buildStreamResponse(() => state.snapshot, clients);
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        try {
          return await handleApiRequest(request, pathname, context);
        } catch (error) {
          logger.error({ err: error }, "Pipeline studio API request failed");
          return jsonError(
            500,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return serveStaticAsset(staticDir, pathname);
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
      await server.stop(true);
    },
  };
}
