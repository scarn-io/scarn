import { describe, expect, test } from "bun:test";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import { automationStarts } from "./automation-targets";

const withDocument = (document: Record<string, unknown> | null) =>
  ({
    key: "triage",
    latestVersion: document === null ? null : { document },
  }) as unknown as AutomationContract;

const names = new Map([["ship-it", "Ship it"]]);

describe("automationStarts", () => {
  test("names pipelines and steps once each, skipping attach and skip", () => {
    const automation = withDocument({
      kind: "automation",
      schemaVersion: 1,
      key: "triage",
      scope: "project",
      rules: [
        {
          event: "workItem.created",
          next: {
            routes: [
              { kind: "pipeline", to: "ship-it", on: "workItem" },
              { kind: "attach", automation: "other" },
            ],
            otherwise: { kind: "step", to: "label", on: "workItem" },
          },
        },
        {
          event: "workItem.created",
          next: {
            routes: [
              { kind: "pipeline", to: "ship-it", on: "workItem" },
              { kind: "pipeline", to: "unknown", on: "workItem" },
              { kind: "skip" },
            ],
          },
        },
      ],
    });

    expect(automationStarts(automation, names)).toEqual([
      "Ship it",
      "label",
      "unknown",
    ]);
  });

  test("an unpublished or unreadable automation starts nothing", () => {
    expect(automationStarts(withDocument(null), names)).toEqual([]);
    expect(automationStarts(withDocument({ rules: "nope" }), names)).toEqual(
      [],
    );
  });
});
