import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  EnvironmentVersionEntity,
  hashEnvironmentContent,
  normalizeEnvironmentContent,
} from "@/pipeline-definitions/environment/domain/environment-version-entity";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const ddApiKey = {
  name: "DD_API_KEY",
  source: "secret",
  secretName: "DD_API_KEY",
} as const;
const ddApplicationKey = {
  name: "DD_APPLICATION_KEY",
  source: "inherit",
  from: "DD_APPLICATION_KEY",
  secret: true,
  optional: false,
} as const;
const datadogVars = [ddApiKey, ddApplicationKey];

const invalidMessage = (content: object): string => {
  try {
    normalizeEnvironmentContent(content);
  } catch (error) {
    if (error instanceof CoreValidationError) {
      expect(error.code).toBe("ENVIRONMENT_CONTENT_INVALID");
      return error.message;
    }
    throw error;
  }
  throw new Error("expected the content to be rejected");
};

describe("environment content validation", () => {
  test("accepts a full environment", () => {
    expect(
      normalizeEnvironmentContent({
        description: "Frontend",
        runtime: { kind: "managed", id: "bun1" },
        vars: datadogVars,
        connectors: ["datadog"],
      }),
    ).toMatchSnapshot();
  });

  concurrentTest("accepts empty content", () => {
    expect(normalizeEnvironmentContent({})).toEqual({});
  });

  concurrentTest("drops empty vars and connectors", () => {
    expect(normalizeEnvironmentContent({ vars: [], connectors: [] })).toEqual(
      {},
    );
  });

  concurrentTest("rejects an invalid runtime", () => {
    expect(invalidMessage({ runtime: { kind: "spaceship" } })).toContain(
      "runtime",
    );
    expect(
      invalidMessage({ runtime: { kind: "managed", id: "nope" } }),
    ).toContain("runtime");
  });

  concurrentTest("rejects `kind` (it is not an inline environment)", () => {
    expect(invalidMessage({ kind: "inline" })).toContain("kind");
  });

  concurrentTest("rejects a branch", () => {
    expect(invalidMessage({ branch: "main" })).toContain(
      "environments have no branch; use the step's repo baseBranch",
    );
  });

  concurrentTest("rejects an unknown connector", () => {
    expect(invalidMessage({ connectors: ["nope"] })).toContain(
      'unknown connector "nope"',
    );
  });

  concurrentTest("rejects a connector missing a required var", () => {
    expect(
      invalidMessage({
        connectors: ["datadog"],
        vars: [ddApiKey],
      }),
    ).toContain('connector "datadog" needs DD_APPLICATION_KEY');
  });

  concurrentTest("a setup-only var does not satisfy a connector", () => {
    expect(
      invalidMessage({
        connectors: ["datadog"],
        vars: [{ ...ddApiKey, applies: "setup" }, ddApplicationKey],
      }),
    ).toContain("DD_API_KEY");
  });

  concurrentTest("rejects a secret var with a default", () => {
    expect(
      invalidMessage({
        vars: [
          {
            name: "TOKEN",
            source: "inherit",
            from: "TOKEN",
            secret: true,
            optional: false,
            default: "plaintext",
          },
        ],
      }),
    ).toContain("a secret cannot carry a default");
  });

  concurrentTest("rejects setup vars on a host runtime", () => {
    expect(
      invalidMessage({
        runtime: { kind: "host" },
        vars: [
          {
            name: "A",
            source: "value",
            value: "1",
            secret: false,
            applies: "setup",
          },
        ],
      }),
    ).toContain("runtime 'host' has no container to set up");
  });
});

describe("environment content hash", () => {
  concurrentTest("ignores object key order", () => {
    expect(
      hashEnvironmentContent(
        normalizeEnvironmentContent({
          description: "x",
          runtime: { kind: "host" },
        }),
      ),
    ).toBe(
      hashEnvironmentContent(
        normalizeEnvironmentContent({
          runtime: { kind: "host" },
          description: "x",
        }),
      ),
    );
  });

  concurrentTest("treats empty lists as omitted", () => {
    expect(
      hashEnvironmentContent(normalizeEnvironmentContent({ vars: [] })),
    ).toBe(hashEnvironmentContent(normalizeEnvironmentContent({})));
  });

  concurrentTest("changes with the description", () => {
    expect(
      hashEnvironmentContent(normalizeEnvironmentContent({ description: "a" })),
    ).not.toBe(
      hashEnvironmentContent(normalizeEnvironmentContent({ description: "b" })),
    );
  });
});

describe("EnvironmentVersionEntity", () => {
  concurrentTest("create hashes the normalized content", () => {
    const version = EnvironmentVersionEntity.create({
      environmentId: createUuidV7(),
      version: 1,
      content: { runtime: { kind: "host" }, connectors: [] },
      createdByUserId: createUuidV7(),
      createdAt: new Date(),
    });
    expect(version.content).toEqual({ runtime: { kind: "host" } });
    expect(version.contentHash).toBe(
      hashEnvironmentContent({ runtime: { kind: "host" } }),
    );
  });

  concurrentTest("rejects a version below 1", () => {
    expect(() =>
      EnvironmentVersionEntity.create({
        environmentId: createUuidV7(),
        version: 0,
        content: {},
        createdByUserId: createUuidV7(),
        createdAt: new Date(),
      }),
    ).toThrow(CoreValidationError);
  });
});
