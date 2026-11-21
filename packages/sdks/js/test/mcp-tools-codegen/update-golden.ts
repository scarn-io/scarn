/**
 * Rewrites the codegen golden files: `bun test/mcp-tools-codegen/update-golden.ts`.
 */
import { writeFileSync } from "node:fs";
import { goldenCases } from "./golden-cases";

for (const golden of goldenCases()) {
  writeFileSync(golden.lockPath, golden.lockText);
  writeFileSync(golden.catalogPath, golden.catalogSource);
}
