import { expect, test } from "bun:test";
import {
  openCodeMcpServersSchema,
  openCodeResolvedMcpServersSchema,
} from "../src/opencode-mcp";

const entry = {
  source: "inherit" as const,
  name: "TOKEN",
  from: "HOST_TOKEN",
  optional: false,
  secret: true,
  applies: "agent" as const,
};

test("each authored variant transports workerVars, never the native schema", () => {
  for (const server of [
    { type: "ref" as const },
    { type: "local" as const, command: ["mcp"] },
    { type: "remote" as const, url: "https://example.com" },
  ]) {
    const servers = { api: { ...server, workerVars: [entry] } };
    expect(openCodeMcpServersSchema.parse(servers)).toEqual(servers);
    expect(openCodeResolvedMcpServersSchema.safeParse(servers).success).toBe(
      false,
    );
  }
});

test("workerVars retain inherited-variable write validation and require agent scope", () => {
  for (const change of [
    { source: "value", value: "literal" },
    { applies: "setup" },
    { applies: "both" },
    { applies: undefined },
    { from: "SCARN_WORKER_TOKEN" },
    { default: "static-secret" },
    { name: "SCARN_RESERVED" },
  ]) {
    expect(
      openCodeMcpServersSchema.safeParse({
        api: { type: "ref", workerVars: [{ ...entry, ...change }] },
      }).success,
    ).toBe(false);
  }
});
