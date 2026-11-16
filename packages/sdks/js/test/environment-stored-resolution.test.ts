import { describe, expect, test } from "bun:test";
import {
  EnvironmentInvalid,
  environmentRefReadSchema,
  environmentRefSchema,
  type ResolvedEnvironmentRefInput,
} from "../src/environment";
import { resolveEnvironment } from "../src/resolve-environment";

const deps = {
  devcontainerExists: () => Promise.resolve(false),
};

describe("persisted environment resolution", () => {
  test.each([
    { name: "HOME" },
    { name: "lowercase" },
    { name: "A".repeat(129) },
    { value: "x".repeat(4097) },
    { secret: true },
    { futureKey: "ignored" },
  ])(
    "read refs accept historical vars while new writes reject %j",
    (change) => {
      const ref = {
        kind: "inline",
        envJson: [
          {
            name: "TOKEN",
            source: "value",
            value: "literal",
            secret: false,
            ...change,
          },
        ],
      };
      expect(environmentRefReadSchema.safeParse(ref).success).toBe(true);
      expect(environmentRefSchema.safeParse(ref).success).toBe(false);
    },
  );

  test("resolves historical vars structurally without reapplying write refinements", async () => {
    const historicalValue = {
      name: "HOME",
      source: "value" as const,
      value: "x".repeat(4097),
      secret: true,
    };
    const historicalInherit = {
      name: "HOME",
      source: "inherit" as const,
      from: "SCARN_OLD",
      secret: true,
      optional: false,
      default: "historical-default",
      mcp: "",
    };
    const entries = [
      historicalValue,
      ...Array.from({ length: 65 }, () => historicalInherit),
    ];
    const ref = {
      kind: "inline" as const,
      envJson: entries.map((entry) => ({ ...entry, futureKey: "ignored" })),
    };
    expect(environmentRefSchema.safeParse(ref).success).toBe(false);
    expect(await resolveEnvironment(deps, ref)).toEqual({
      source: "inline",
      runtime: { kind: "managed", id: "bun1" },
      envVars: entries.map((entry) => ({ ...entry, applies: "agent" })),
      connectors: [],
    });
  });

  test("persisted inline vars still require their stored structure", async () => {
    const ref = {
      kind: "inline",
      envJson: [{ name: "HOME", source: "value", value: 123, secret: false }],
    };
    expect(
      await resolveEnvironment(
        deps,
        ref as unknown as ResolvedEnvironmentRefInput,
      ),
    ).toBeInstanceOf(EnvironmentInvalid);
  });
});
