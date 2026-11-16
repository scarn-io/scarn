import { describe, expect, test } from "bun:test";
import {
  BrokenDevcontainerReference,
  EnvironmentInvalid,
  EnvironmentNotFound,
  type ResolvedEnvironment,
  type ResolvedEnvironmentRefInput,
} from "../src/environment";
import {
  resolveEnvironment,
  type ResolveEnvironmentDeps,
} from "../src/resolve-environment";

type NamedContent = Extract<
  ResolvedEnvironmentRefInput,
  { content: unknown }
>["content"];

const named = (content: NamedContent = {}): ResolvedEnvironmentRefInput => ({
  kind: "named",
  name: "frontend",
  version: 2,
  content,
});

function fixture(paths: string[] = []) {
  const checks: string[] = [];
  const deps: ResolveEnvironmentDeps = {
    devcontainerExists(path) {
      checks.push(path);
      return Promise.resolve(paths.includes(path));
    },
  };
  return { deps, checks };
}

describe("resolveEnvironment", () => {
  const refs: ResolvedEnvironmentRefInput[] = [
    null,
    { kind: "inline" },
    named(),
  ];
  for (const ref of refs) {
    test.each([
      [[], { kind: "managed", id: "bun1" }],
      [
        ["devcontainer.json"],
        { kind: "devcontainer", config: "devcontainer.json" },
      ],
      [
        [".devcontainer/devcontainer.json"],
        { kind: "devcontainer", config: ".devcontainer/devcontainer.json" },
      ],
      [
        ["devcontainer.json", ".devcontainer/devcontainer.json"],
        { kind: "devcontainer", config: ".devcontainer/devcontainer.json" },
      ],
    ] satisfies [string[], ResolvedEnvironment["runtime"]][])(
      "defaults %j for ref " + JSON.stringify(ref),
      async (paths, runtime) => {
        const { deps } = fixture(paths);
        expect(await resolveEnvironment(deps, ref)).toEqual({
          source: ref?.kind ?? "repo-default",
          ...(ref?.kind === "named" ? { name: ref.name } : {}),
          runtime,
          envVars: [],
          connectors: [],
        });
      },
    );
  }

  test("named content carries every optional field", async () => {
    const { deps, checks } = fixture();
    expect(
      await resolveEnvironment(
        deps,
        named({
          description: "Human description",
          runtime: { kind: "managed", id: "node24" },
          vars: [
            {
              name: "MODE",
              source: "value",
              value: "development",
              secret: false,
            },
          ],
        }),
      ),
    ).toEqual({
      source: "named",
      name: "frontend",
      runtime: { kind: "managed", id: "node24" },
      envVars: [
        {
          name: "MODE",
          source: "value",
          value: "development",
          secret: false,
          applies: "agent",
        },
      ],
      connectors: [],
    });
    expect(checks).toEqual([]);
  });

  test.each<NamedContent["runtime"]>([
    { kind: "host" },
    { kind: "managed", id: "bun1" },
    { kind: "managed", id: "node24" },
  ])("explicit runtime %j bypasses discovery", async (runtime) => {
    const { deps, checks } = fixture();
    const result = await resolveEnvironment(deps, named({ runtime }));
    expect(result).not.toBeInstanceOf(Error);
    expect(checks).toEqual([]);
  });

  test("inline retains compiled templates", async () => {
    const { deps } = fixture();
    const entry = {
      name: "TOKEN",
      source: "value" as const,
      value: "{{input.token}}",
      secret: true,
    };
    const envJson = [entry];
    expect(
      await resolveEnvironment(deps, {
        kind: "inline",
        runtime: { kind: "host" },
        envJson,
      }),
    ).toEqual({
      source: "inline",
      runtime: { kind: "host" },
      envVars: [{ ...entry, applies: "agent" }],
      connectors: [],
    });
  });

  test.each([
    [".devcontainer/devcontainer.json", [".devcontainer/devcontainer.json"]],
    [
      "devcontainer.json",
      [".devcontainer/devcontainer.json", "devcontainer.json"],
    ],
  ] satisfies [string, string[]][])(
    "explicit pathless devcontainer discovers %s with null vars",
    async (config, expectedChecks) => {
      const { deps, checks } = fixture([config]);
      expect(
        await resolveEnvironment(deps, {
          kind: "inline",
          runtime: { kind: "devcontainer" },
          envJson: null,
        }),
      ).toEqual({
        source: "inline",
        runtime: { kind: "devcontainer", config },
        envVars: [],
        connectors: [],
      });
      expect(checks).toEqual(expectedChecks);
    },
  );

  test("explicit pathless devcontainer missing never falls back to managed", async () => {
    const { deps, checks } = fixture();
    const result = await resolveEnvironment(deps, {
      kind: "inline",
      runtime: { kind: "devcontainer" },
    });
    expect(result).toBeInstanceOf(BrokenDevcontainerReference);
    expect(result).toMatchObject({
      configPath: ".devcontainer/devcontainer.json",
      code: "SCARN_DEVCONTAINER_REFERENCE_BROKEN",
      message:
        "Devcontainer auto-discovery found no config; checked: .devcontainer/devcontainer.json, devcontainer.json",
    });
    expect(checks).toEqual([
      ".devcontainer/devcontainer.json",
      "devcontainer.json",
    ]);
  });

  test.each(["named", "inline"] as const)(
    "explicit %s devcontainer missing never falls back",
    async (kind) => {
      const { deps, checks } = fixture([".devcontainer/devcontainer.json"]);
      const runtime = {
        kind: "devcontainer" as const,
        config: "./custom/devcontainer.json",
      };
      const ref: ResolvedEnvironmentRefInput =
        kind === "named" ? named({ runtime }) : { kind, runtime };
      const result = await resolveEnvironment(deps, ref);
      expect(result).toBeInstanceOf(BrokenDevcontainerReference);
      expect(result).toMatchObject({
        configPath: "custom/devcontainer.json",
        code: "SCARN_DEVCONTAINER_REFERENCE_BROKEN",
      });
      expect(checks).toEqual(["custom/devcontainer.json"]);
    },
  );

  test("explicit devcontainer present returns normalized path", async () => {
    const { deps, checks } = fixture(["custom/devcontainer.json"]);
    expect(
      await resolveEnvironment(
        deps,
        named({
          runtime: {
            kind: "devcontainer",
            config: "./custom/devcontainer.json",
          },
        }),
      ),
    ).toMatchObject({
      runtime: { kind: "devcontainer", config: "custom/devcontainer.json" },
    });
    expect(checks).toEqual(["custom/devcontainer.json"]);
  });

  test("a named environment the project no longer has is not found", async () => {
    const { deps, checks } = fixture();
    const result = await resolveEnvironment(deps, {
      kind: "named",
      name: "frontend",
      notFound: true,
    });
    expect(result).toBeInstanceOf(EnvironmentNotFound);
    expect(result).toMatchObject({
      environmentName: "frontend",
      code: "SCARN_ENVIRONMENT_NOT_FOUND",
      message: "Environment not found: frontend",
    });
    expect(checks).toEqual([]);
  });

  test.each<[string, unknown]>([
    [
      "unknown managed runtime",
      { runtime: { kind: "managed", id: "unknown" } },
    ],
    [
      "escaping devcontainer path",
      { runtime: { kind: "devcontainer", config: "../devcontainer.json" } },
    ],
    [
      "setup var on host",
      {
        runtime: { kind: "host" },
        vars: [
          {
            name: "TOKEN",
            source: "value",
            value: "",
            secret: false,
            applies: "setup",
          },
        ],
      },
    ],
    ["unknown connector", { connectors: ["nope"] }],
  ])(
    "invalid named content (%s) names the environment version",
    async (_label, content) => {
      const { deps, checks } = fixture();
      const result = await resolveEnvironment(
        deps,
        named(content as NamedContent),
      );
      expect(result).toBeInstanceOf(EnvironmentInvalid);
      if (!(result instanceof EnvironmentInvalid))
        throw new Error("expected invalid");
      expect(result.environment).toBe("environment frontend v2");
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.message).toContain("environment frontend v2");
      expect(result.message).toContain(result.issues[0]?.message ?? "");
      expect(checks).toEqual([]);
    },
  );

  test("invalid named vars report under the content's vars key", async () => {
    const { deps } = fixture();
    const result = await resolveEnvironment(
      deps,
      named({
        runtime: { kind: "host" },
        vars: [
          {
            name: "TOKEN",
            source: "value",
            value: "",
            secret: false,
            applies: "both",
          },
        ],
      }),
    );
    expect(result).toBeInstanceOf(EnvironmentInvalid);
    expect((result as EnvironmentInvalid).issues[0]?.path[0]).toBe("vars");
  });

  test.each([
    { kind: "named", name: "../escape", version: 1, content: {} },
    { kind: "named", name: "frontend" },
    { kind: "inline", runtime: { kind: "managed", id: "unknown" } },
    {
      kind: "inline",
      runtime: { kind: "devcontainer", config: "../devcontainer.json" },
    },
    ...["setup", "both"].map((applies) => ({
      kind: "inline",
      runtime: { kind: "host" },
      envJson: [
        { name: "TOKEN", source: "value", value: "", secret: false, applies },
      ],
    })),
  ])("invalid ref returns typed error %j", async (ref) => {
    const { deps, checks } = fixture();
    expect(
      await resolveEnvironment(deps, ref as ResolvedEnvironmentRefInput),
    ).toBeInstanceOf(EnvironmentInvalid);
    expect(checks).toEqual([]);
  });

  test("dependency errors propagate without fallback", async () => {
    const ioError = new Error("git checkout failed");
    const { deps } = fixture();
    deps.devcontainerExists = () => Promise.reject(ioError);
    try {
      await resolveEnvironment(deps, null);
      throw new Error("expected dependency failure");
    } catch (error) {
      expect(error).toBe(ioError);
    }
  });

  test("presence-only dependency never reads or builds existing devcontainer", async () => {
    const { deps, checks } = fixture([".devcontainer/devcontainer.json"]);
    expect(await resolveEnvironment(deps, null)).toMatchObject({
      runtime: {
        kind: "devcontainer",
        config: ".devcontainer/devcontainer.json",
      },
    });
    expect(checks).toEqual([".devcontainer/devcontainer.json"]);
  });
});
