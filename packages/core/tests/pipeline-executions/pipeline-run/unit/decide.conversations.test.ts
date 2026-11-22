import { describe, expect, test } from "bun:test";
import type { StepCatalog } from "@scarn/sdk/contracts/pipeline-document";
import { RunSimulator } from "./engine-harness";
import { obj } from "./engine-fixture-schema";

const grillSteps: StepCatalog = {
  grill: {
    inputSchema: obj("GrillInput", {}),
    resultSchema: null,
    errors: [],
  },
  write: {
    inputSchema: obj("WriteInput", { summary: { type: "string" } }),
    resultSchema: obj("WriteResult", {}),
    errors: [],
  },
};

/** A conversation step (`grill`, no result schema) that passes its summary on to `write`. */
function grillRun() {
  return new RunSimulator(
    {
      schemaVersion: 1,
      key: "grill",
      start: { to: "grill" },
      nodes: {
        grill: {
          kind: "step",
          step: "grill",
          next: {
            routes: [{ to: "write", args: { summary: "result.summary" } }],
          },
        },
        write: {
          kind: "step",
          step: "write",
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
      },
    },
    grillSteps,
  ).start();
}

describe("decide: conversation steps", () => {
  test.concurrent(
    "a Task a person ended succeeds the visit with its { conversationId, summary } and follows next",
    () => {
      const run = grillRun();
      run.yield("grill", "SAML only, or SAML and OIDC?");
      const visit = run.open("grill");
      const result = run.end("grill", "SAML and OIDC, SAML first.");
      expect(result.ignored).toBeUndefined();
      expect(run.visits("grill")[0]).toMatchObject({
        status: "succeeded",
        result: {
          conversationId: visit.conversationId,
          summary: "SAML and OIDC, SAML first.",
        },
        resultTaskId: null,
        completedAt: expect.any(String) as string,
      });
      expect(run.trail()).toEqual(["grill:succeeded", "write:active"]);
      expect(run.queued()).toMatchObject([
        { stepKey: "write", input: { summary: "SAML and OIDC, SAML first." } },
      ]);
      expect(run.state.run.status).toBe("active");
    },
  );

  test.concurrent(
    "a person's end is ignored on a visit that isn't waiting",
    () => {
      const run = grillRun();
      const active = run.end("grill", "too early");
      expect(active.commands).toEqual([]);
      expect(active.ignored?.message).toContain("active");

      run.yield("grill", "Anything else?");
      run.reply("grill");
      const replied = run.end("grill", "still running");
      expect(replied.commands).toEqual([]);
      expect(replied.ignored?.message).toContain("active");
      expect(run.open("grill").status).toBe("active");
    },
  );
});
