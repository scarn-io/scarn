import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { signLogFeedToken } from "@scarn/core/tasks/task-log/domain/log-feed-token";

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

describe("signLogFeedToken", () => {
  it("produces an HS256 JWT carrying the task run, project, org, scope and expiry", async () => {
    const claims = {
      tid: "task-run-1",
      pid: "project-1",
      oid: "org-1",
      scope: "read" as const,
      exp: 1_900_000_000,
    };

    const token = await signLogFeedToken(claims, "secret");
    const [header = "", payload = "", signature] = token.split(".");

    expect(decodeSegment(header)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decodeSegment(payload)).toEqual(claims);
    expect(signature).toBe(
      createHmac("sha256", "secret")
        .update(`${header}.${payload}`)
        .digest("base64url"),
    );
  });

  it("emits base64url segments without padding", async () => {
    const token = await signLogFeedToken(
      { tid: "t", pid: "p", oid: "o", scope: "write", exp: 1 },
      "secret",
    );

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
