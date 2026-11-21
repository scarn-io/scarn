/** The codegen golden cases: each fixture's lock and generated catalog. */
import { join } from "node:path";
import {
  buildMcpToolLock,
  generateMcpToolCatalogSource,
  mcpToolCatalogFileName,
  mcpToolLockFileName,
  serializeMcpToolLock,
  type ListedMcpToolInput,
} from "../../src/mcp-tools/codegen";
import { edgeCaseListedTools, LISTED_AT, notionListedTools } from "./fixtures";

export const GOLDEN_DIR = join(import.meta.dir, "golden");

const fixtures: [server: string, tools: ListedMcpToolInput[]][] = [
  ["notion", notionListedTools],
  ["edge-cases", edgeCaseListedTools],
];

export function goldenCases() {
  return fixtures.map(([server, tools]) => {
    const lock = buildMcpToolLock({ server, listedAt: LISTED_AT, tools });
    const generated = generateMcpToolCatalogSource(lock, {
      importFrom: "../../../src/definitions/steps",
    });
    return {
      server,
      lock,
      lockText: serializeMcpToolLock(lock),
      lockPath: join(GOLDEN_DIR, mcpToolLockFileName(server)),
      catalogSource: generated.source,
      catalogPath: join(GOLDEN_DIR, mcpToolCatalogFileName(server)),
      warnings: generated.warnings,
    };
  });
}
