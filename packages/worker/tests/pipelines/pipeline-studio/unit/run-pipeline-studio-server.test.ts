import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MISSING_STUDIO_ASSETS_MESSAGE,
  runPipelineStudioServer,
} from "../../../../src/pipelines/pipeline-studio/application/run-pipeline-studio-server";
import type { StudioSnapshot } from "@scarn/pipeline-studio-ui";

/**
 * A real `Bun.serve` + real `fs.watch` smoke test — deliberately NOT a fake,
 * unlike `apps/cli`'s command-wiring tests (see the phase report): this is
 * the one place that mechanism itself is exercised end to end. The server
 * refuses to start without a built `index.html`, so each test points it at a
 * temp static dir rather than requiring `packages/pipeline-studio-ui`'s build
 * output on disk.
 */

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "scarn-studio-server-test-"));
}

function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scarn-studio-static-test-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  return dir;
}

async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("Expected the probe to bind a port");
  return port;
}

const PIPELINE_V1 = JSON.stringify({
  schemaVersion: 1,
  key: "review-pr",
  title: "Review PR",
  start: { to: "done" },
  nodes: { done: { kind: "succeed" } },
});

const PIPELINE_V2 = JSON.stringify({
  schemaVersion: 1,
  key: "review-pr",
  title: "Review PR",
  start: { to: "approve" },
  nodes: {
    approve: {
      kind: "wait",
      for: "decision",
      actions: [
        { key: "approve", label: "Approve", body: "optional" },
        { key: "reject", label: "Reject", body: "optional" },
      ],
      next: {
        routes: [{ to: "done" }],
      },
    },
    done: { kind: "succeed" },
  },
});

const WORKER_NODE_MODULES = resolve(
  import.meta.dir,
  "../../../../node_modules",
);

const TS_PIPELINE = `import { decision, definePipeline, succeed } from "@scarn/sdk/pipelines";

const approve = decision("approve", {
  actions: {
    approve: { label: "Approve" },
    reject: { label: "Reject" },
  },
});

export default definePipeline({
  key: "review-pr",
  title: "Review PR",
  start: approve,
  flow: [approve.next(succeed("done"))],
});
`;

/** Reads one `data: {...}\n\n` SSE frame from a stream reader. */
async function readOneSnapshot(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<StudioSnapshot> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Stream closed before a full SSE frame arrived");
    buffer += decoder.decode(value, { stream: true });
    const frameEnd = buffer.indexOf("\n\n");
    if (frameEnd === -1) continue;
    const frame = buffer.slice(0, frameEnd);
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error(`Malformed SSE frame: ${frame}`);
    return JSON.parse(dataLine.slice("data: ".length)) as StudioSnapshot;
  }
}

describe("runPipelineStudioServer", () => {
  test("streams an initial snapshot, then a fresh one after a file change", async () => {
    const dir = makeTempDir();
    const staticDir = makeStaticDir();
    const handle = await runPipelineStudioServer({
      builderDir: dir,
      cliVersion: "0.0.0",
      staticDir,
    });
    try {
      writeFileSync(join(dir, "review-pr.json"), PIPELINE_V1);
      // The handle's own preflight snapshot predates this write, so the
      // FIRST stream connection is what actually observes it.
      const response = await fetch(`${handle.url}/api/stream`);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a readable SSE body");

      const initial = await readOneSnapshot(reader);
      expect(initial.status).toBe("ok");

      writeFileSync(join(dir, "review-pr.json"), PIPELINE_V2);

      const updated = await readOneSnapshot(reader);
      expect(updated.status).toBe("ok");
      if (updated.status !== "ok") return;
      expect(updated.pipelines[0]?.nodes).toHaveLength(3);
      expect(updated.pipelines[0]?.edges).toHaveLength(2);

      await reader.cancel();
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("rebuilds a changed .ts pipeline to JSON, then renders it", async () => {
    const dir = makeTempDir();
    const staticDir = makeStaticDir();
    symlinkSync(WORKER_NODE_MODULES, join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, "bun.lock"), "");
    const handle = await runPipelineStudioServer({
      builderDir: dir,
      cliVersion: "0.0.0",
      staticDir,
    });
    try {
      const response = await fetch(`${handle.url}/api/stream`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a readable SSE body");
      await readOneSnapshot(reader);

      writeFileSync(join(dir, "review-pr.ts"), TS_PIPELINE);

      let snapshot = await readOneSnapshot(reader);
      while (snapshot.status === "ok" && snapshot.pipelines.length === 0) {
        snapshot = await readOneSnapshot(reader);
      }
      expect(existsSync(join(dir, "review-pr.json"))).toBe(true);
      expect(snapshot.status).toBe("ok");
      if (snapshot.status !== "ok") return;
      expect(snapshot.pipelines[0]?.nodes).toHaveLength(3);

      await reader.cancel();
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("close() stops accepting new connections", async () => {
    const dir = makeTempDir();
    const staticDir = makeStaticDir();
    const handle = await runPipelineStudioServer({
      builderDir: dir,
      cliVersion: "0.0.0",
      staticDir,
    });
    const url = handle.url;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });

    let failed = false;
    try {
      await fetch(`${url}/api/stream`);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("refuses to start, without binding a port, when the built assets are missing", async () => {
    const dir = makeTempDir();
    const emptyStaticDir = makeTempDir();
    const port = await findFreePort();
    try {
      let thrown: unknown;
      try {
        const handle = await runPipelineStudioServer({
          builderDir: dir,
          cliVersion: "0.0.0",
          port,
          staticDir: emptyStaticDir,
        });
        await handle.close();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(MISSING_STUDIO_ASSETS_MESSAGE);
      expect(MISSING_STUDIO_ASSETS_MESSAGE).toContain(
        "bun run --filter @scarn/pipeline-studio-ui build",
      );

      let connectionRefused = false;
      try {
        await fetch(`http://localhost:${String(port)}/`);
      } catch {
        connectionRefused = true;
      }
      expect(connectionRefused).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(emptyStaticDir, { recursive: true, force: true });
    }
  });
});
