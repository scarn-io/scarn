/**
 * Regenerates `ld-codestep-with-mcp`'s typed inventory catalog: lists the tools of
 * `local-test-project/.scarn/inventory-mcp.mjs` over stdio and writes
 * `mcp/inventory.lock.json` and `mcp/inventory.tools.ts` into the pipeline
 * builder, with the same codegen `scarn mcp pull` uses. Run it after changing
 * a tool; `scarn mcp pull` itself needs a checkout, which seed rebuilds.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  buildMcpToolLock,
  generateMcpToolCatalogSource,
  mcpToolCatalogFileName,
  mcpToolLockFileName,
  serializeMcpToolLock,
  type ListedMcpToolInput,
} from "@scarn/sdk/mcp-tools/codegen";

const SERVER = "inventory";
const SCARN_DIR = path.join(import.meta.dir, "local-test-project", ".scarn");
const CATALOG_DIR = path.join(SCARN_DIR, "pipeline-builder", "mcp");

async function listTools(): Promise<ListedMcpToolInput[]> {
  const child = spawn("bun", [path.join(SCARN_DIR, "inventory-mcp.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  type Reply = { id: number; result?: { tools?: ListedMcpToolInput[] } };
  const replies = new Map<number, (reply: Reply) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as Reply;
    replies.get(reply.id)?.(reply);
  });
  const request = (id: number, method: string, params: object) =>
    new Promise<Reply>((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  try {
    await request(1, "initialize", { protocolVersion: "2025-06-18" });
    const listed = await request(2, "tools/list", {});
    return listed.result?.tools ?? [];
  } finally {
    child.kill();
  }
}

const lock = buildMcpToolLock({
  server: SERVER,
  listedAt: new Date(),
  tools: await listTools(),
});
const catalog = generateMcpToolCatalogSource(lock);
await mkdir(CATALOG_DIR, { recursive: true });
await writeFile(
  path.join(CATALOG_DIR, mcpToolLockFileName(SERVER)),
  serializeMcpToolLock(lock),
);
await writeFile(
  path.join(CATALOG_DIR, mcpToolCatalogFileName(SERVER)),
  catalog.source,
);
for (const warning of catalog.warnings) {
  process.stderr.write(`[local-dev] ${warning}\n`);
}
process.stdout.write(
  `[local-dev] wrote ${catalog.exportName} (${catalog.keys.map((k) => k.key).join(", ")}) to ${CATALOG_DIR}\n`,
);
