import { describe, expect } from "bun:test";
import {
  convertTaskExecutionConfigV1ToV2,
  convertTaskExecutionConfigV2ToV3,
  storedTaskExecutionConfigV1Schema,
  storedTaskExecutionConfigV2Schema,
  storedTaskExecutionConfigV3Schema,
  type TaskExecutionConfigContentV2,
} from "@/tasks/task-execution-config/contracts/task-execution-config-stored";
import { concurrentTest } from "tests/utils";
import v1Fixture from "../fixtures/v1.json";
import v2Fixture from "../fixtures/v2.json";
import v3Fixture from "../fixtures/v3.json";

const emptyV2: TaskExecutionConfigContentV2 = {
  runtime: null,
  env: null,
  git: null,
  mcp: null,
  healthChecks: null,
};

describe("task execution config stored v3", () => {
  concurrentTest("converts the v2 fixture into the v3 fixture", () => {
    const converted = convertTaskExecutionConfigV2ToV3(
      storedTaskExecutionConfigV2Schema.parse({
        runtime: v2Fixture.runtimeJson,
        env: v2Fixture.envJson,
        git: v2Fixture.gitJson,
        mcp: v2Fixture.mcpJson,
        healthChecks: v2Fixture.healthChecksJson,
      }),
    );
    expect<object>(converted).toEqual({
      environment: v3Fixture.environmentJson,
      git: v3Fixture.gitJson,
      mcp: v3Fixture.mcpJson,
      healthChecks: v3Fixture.healthChecksJson,
    });
    expect(storedTaskExecutionConfigV3Schema.parse(converted)).toEqual(
      converted,
    );
  });

  concurrentTest("keeps null overrides as repo default", () => {
    expect(convertTaskExecutionConfigV2ToV3(emptyV2)).toEqual({
      environment: null,
      git: null,
      mcp: null,
      healthChecks: null,
    });
  });

  concurrentTest(
    "normalizes each explicit runtime without inventing vars",
    () => {
      const cases = [
        [{ type: "host" }, { kind: "host" }],
        [
          { type: "managed", id: "bun1" },
          { kind: "managed", id: "bun1" },
        ],
        [{ type: "devcontainer" }, { kind: "devcontainer" }],
        [
          { type: "devcontainer", configPath: ".devcontainer/alt.json" },
          { kind: "devcontainer", config: ".devcontainer/alt.json" },
        ],
        [
          { type: "devcontainer", configPath: "" },
          { kind: "devcontainer", config: "" },
        ],
      ] as const;
      for (const [runtime, expected] of cases) {
        const converted = convertTaskExecutionConfigV2ToV3({
          ...emptyV2,
          runtime,
        });
        expect(converted.environment).toEqual({
          kind: "inline",
          runtime: expected,
        });
        expect(converted.environment).not.toHaveProperty("vars");
        expect(converted.environment).not.toHaveProperty("branch");
        expect(storedTaskExecutionConfigV3Schema.parse(converted)).toEqual(
          converted,
        );
      }
    },
  );

  concurrentTest(
    "retains env-only overrides including an explicit empty array",
    () => {
      for (const env of [[], v1Fixture.envJson]) {
        const content = storedTaskExecutionConfigV2Schema.parse({
          ...emptyV2,
          env,
        });
        const converted = convertTaskExecutionConfigV2ToV3(content);
        expect<object | null>(converted.environment).toEqual({
          kind: "inline",
          vars: content.env,
        });
        expect(converted.environment).not.toHaveProperty("runtime");
      }
    },
  );

  concurrentTest(
    "preserves structural vars for every source and applies scope",
    () => {
      const env = ["agent", "setup", "both"].flatMap((applies) =>
        [false, true].flatMap((secret) => [
          {
            name: "not a write-valid name",
            source: "value",
            value: "{{input.old}}",
            secret,
            applies,
          },
          {
            name: "PATH",
            source: "inherit",
            from: "",
            secret,
            optional: true,
            default: "fallback",
            mcp: "github",
            applies,
          },
        ]),
      );
      const content = storedTaskExecutionConfigV2Schema.parse({
        ...emptyV2,
        runtime: { type: "host" },
        env,
      });
      const converted = convertTaskExecutionConfigV2ToV3(content);
      expect<object | null>(converted.environment).toEqual({
        kind: "inline",
        runtime: { kind: "host" },
        vars: env,
      });
      expect(storedTaskExecutionConfigV3Schema.parse(converted)).toEqual(
        converted,
      );
      expect<object | null>(content.env).toEqual(env);
    },
  );

  concurrentTest("retains the stored legacy applies default", () => {
    const content = storedTaskExecutionConfigV2Schema.parse({
      ...emptyV2,
      env: [
        { name: "OLD", source: "value", value: "", secret: true },
        {
          name: "TOKEN",
          source: "inherit",
          from: "TOKEN",
          secret: true,
          optional: false,
        },
      ],
    });
    const converted = convertTaskExecutionConfigV2ToV3(content);
    if (converted.environment?.kind !== "inline") {
      throw new Error("expected inline environment");
    }
    expect<object | null | undefined>(converted.environment.vars).toBe(
      content.env,
    );
    expect(converted.environment.vars?.map((entry) => entry.applies)).toEqual([
      "agent",
      "agent",
    ]);
    expect(storedTaskExecutionConfigV3Schema.parse(converted)).toEqual(
      converted,
    );
  });

  concurrentTest(
    "preserves git, mcp and health checks without mutating v2",
    () => {
      const content = storedTaskExecutionConfigV2Schema.parse({
        runtime: v1Fixture.runtimeJson,
        env: v1Fixture.envJson,
        git: v1Fixture.gitJson,
        mcp: v1Fixture.mcpJson,
        healthChecks: v1Fixture.healthChecksJson,
      });
      const before = structuredClone(content);
      const converted = convertTaskExecutionConfigV2ToV3(content);
      expect(converted.git).toBe(content.git);
      expect(converted.mcp).toBe(content.mcp);
      expect(converted.healthChecks).toBe(content.healthChecks);
      expect(converted).not.toHaveProperty("runtime");
      expect(converted).not.toHaveProperty("env");
      expect(content).toEqual(before);
    },
  );

  concurrentTest(
    "accepts named refs structurally without write-time name rules",
    () => {
      for (const name of ["", "Old Name / not write-valid"]) {
        const content = {
          ...convertTaskExecutionConfigV2ToV3(emptyV2),
          environment: { kind: "named", name, unknown: true },
        };
        expect(
          storedTaskExecutionConfigV3Schema.parse(content).environment,
        ).toEqual({ kind: "named", name });
      }
    },
  );

  concurrentTest(
    "keeps new inline fields structural and strips unknown keys",
    () => {
      for (const runtime of [
        { kind: "devcontainer", config: "../legacy.json" },
        { kind: "managed", id: "bun1" },
        { kind: "host" },
      ] as const) {
        expect(
          storedTaskExecutionConfigV3Schema.parse({
            ...convertTaskExecutionConfigV2ToV3(emptyV2),
            environment: {
              kind: "inline",
              runtime: { ...runtime, extra: true },
              branch: "",
              vars: [],
              extra: true,
            },
            extra: true,
          }),
        ).toEqual({
          environment: { kind: "inline", runtime, branch: "", vars: [] },
          git: null,
          mcp: null,
          healthChecks: null,
        });
      }
    },
  );

  concurrentTest("composes v1 none and default git policies through v2", () => {
    for (const runtime of [null, { type: "none" }, { type: "devcontainer" }]) {
      for (const git of [null, { mode: "none" }, { mode: "readOnly" }]) {
        const v1 = storedTaskExecutionConfigV1Schema.parse({
          ...emptyV2,
          runtime,
          git,
        });
        const v2 = convertTaskExecutionConfigV1ToV2(v1);
        const v3 = convertTaskExecutionConfigV2ToV3(v2);
        expect(v3.git).toEqual(
          git?.mode === "none" || (runtime?.type === "none" && git === null)
            ? { mode: "readOnly", gitCredentials: "none" }
            : git === null
              ? null
              : { mode: "readOnly", gitCredentials: "auto" },
        );
        expect(v3.environment).toEqual(
          runtime === null
            ? null
            : {
                kind: "inline",
                runtime: {
                  kind: runtime.type === "none" ? "host" : "devcontainer",
                },
              },
        );
        expect(storedTaskExecutionConfigV3Schema.parse(v3)).toEqual(v3);
      }
    }
  });
});
