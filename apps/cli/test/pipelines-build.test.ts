import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reporterLines, runCli } from "./utils";

const CLI_NODE_MODULES = resolve(import.meta.dir, "../node_modules");
const BUILDER = join(".scarn", "pipeline-builder");

const STEPS = `import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";

export const classify = codeStep({
  key: "classify",
  name: "Classify",
  inputSchema: z.object({ title: z.string() }),
  resultSchema: z.object({ critical: z.boolean() }),
  fn: () => ({ critical: true }),
});

export const page = codeStep({
  key: "page",
  name: "Page",
  inputSchema: z.object({ critical: z.boolean() }),
  fn: () => ({}),
});

export const ticket = codeStep({ key: "ticket", name: "Ticket", fn: () => ({}) });
`;

const VALID = `import { definePipeline, equal, succeed, workItem } from "@scarn/sdk/pipelines";
import { classify, page, ticket } from "./steps";

const done = succeed("done");

export default definePipeline({
  key: "incident",
  title: "Route an incident",
  start: classify({ title: workItem.title }),
  flow: [
    classify.next({
      routes: [
        {
          when: (r) => equal(r.result.critical, true),
          to: (r) => page({ critical: r.result.critical }),
        },
      ],
      otherwise: ticket,
    }),
    page.next(done),
    ticket.next(done),
  ],
});
`;

const EXPECTED_JSON = {
  schemaVersion: 1,
  key: "incident",
  title: "Route an incident",
  start: { to: "classify", args: { title: "workItem.title" } },
  nodes: {
    classify: {
      kind: "step",
      step: "classify",
      next: {
        routes: [
          {
            when: { path: "result.critical", op: "equal", value: true },
            to: "page",
            args: { critical: "result.critical" },
          },
        ],
        otherwise: { to: "ticket" },
      },
    },
    page: {
      kind: "step",
      step: "page",
      next: {
        routes: [{ to: "done" }],
      },
    },
    ticket: {
      kind: "step",
      step: "ticket",
      next: {
        routes: [{ to: "done" }],
      },
    },
    done: { kind: "succeed" },
  },
};

const BUILD_ERROR = `import { definePipeline, succeed, workItem } from "@scarn/sdk/pipelines";
import { classify } from "./steps";

const done = succeed("done");

export default definePipeline({
  key: "wired-twice",
  start: classify({ title: workItem.title }),
  flow: [classify.next(done), classify.next(done)],
});
`;

const VALIDATION_ERROR = `import { definePipeline, equal, succeed } from "@scarn/sdk/pipelines";
import { classify, page, ticket } from "./steps";

const done = succeed("done");

export default definePipeline({
  key: "not-dominated",
  start: ticket,
  flow: [
    ticket.next((r) => page({ critical: r.node(classify).result.critical })),
    page.next({
      routes: [{ when: (r) => equal(r.result, {}), to: done }],
      otherwise: classify({ title: "x" }),
    }),
    classify.next(done),
  ],
});
`;

const STEP_REF = `import { definePipeline, stepRef, succeed } from "@scarn/sdk/pipelines";

const remote = stepRef("server-only");

export default definePipeline({
  key: "remote",
  start: remote,
  flow: [remote.next(succeed("done"))],
});
`;

const DESCRIPTION = `import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";
import { definePipeline, succeed, workItem } from "@scarn/sdk/pipelines";

const triage = codeStep({
  key: "triage",
  name: "Triage",
  inputSchema: z.object({ title: z.string(), description: z.string().nullable() }),
  fn: () => ({}),
});

export default definePipeline({
  key: "described",
  start: triage({ title: workItem.title, description: workItem.description }),
  flow: [triage.next(succeed("done"))],
});
`;

const OLD_SDK = `export default { key: "old", name: "Old", version: 1, nodeDefinitions: [] };
`;

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A project root with a pipeline-builder directory holding `files`. */
function project(files: Record<string, string>): {
  root: string;
  builder: string;
  home: string;
} {
  const root = mkdtempSync(join(tmpdir(), "scarn-pipelines-build-"));
  dirs.push(root);
  const builder = join(root, BUILDER);
  const home = join(root, "home");
  mkdirSync(builder, { recursive: true });
  mkdirSync(home);
  symlinkSync(CLI_NODE_MODULES, join(builder, "node_modules"), "dir");
  writeFileSync(join(builder, "bun.lock"), "");
  writeFileSync(join(builder, "steps.ts"), STEPS);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(builder, name), text);
  }
  return { root, builder, home };
}

function build(
  root: string,
  home: string,
  args: readonly string[] = [],
): ReturnType<typeof runCli> {
  return runCli(["pipelines", "build", ...args], {
    cwd: root,
    env: { HOME: home, SCARN_BASE_URL: "http://127.0.0.1:9" },
  });
}

const output = (result: { stderr: string }) =>
  reporterLines(result.stderr).join("\n");

describe("scarn pipelines build", () => {
  test("writes <key>.json next to the source", async () => {
    const { root, builder, home } = project({ "incident.ts": VALID });

    const result = await build(root, home);

    expect(result.exitCode).toBe(0);
    const text = readFileSync(join(builder, "incident.json"), "utf8");
    expect(JSON.parse(text)).toEqual(EXPECTED_JSON);
    expect(text).toBe(`${JSON.stringify(EXPECTED_JSON, null, 2)}\n`);
    expect(existsSync(join(builder, ".scarn-build.ts"))).toBe(false);
  });

  test(
    "--check passes when up to date and fails on drift",
    async () => {
      const { root, builder, home } = project({ "incident.ts": VALID });

      const missing = await build(root, home, ["--check"]);
      expect(missing.exitCode).toBe(1);
      expect(output(missing)).toContain("incident.json is missing");
      expect(existsSync(join(builder, "incident.json"))).toBe(false);

      expect((await build(root, home)).exitCode).toBe(0);
      const upToDate = await build(root, home, ["--check"]);
      expect(upToDate.exitCode).toBe(0);
      expect(output(upToDate)).toContain("incident.json is up to date");

      writeFileSync(join(builder, "incident.json"), "{}\n");
      const stale = await build(root, home, ["--check"]);
      expect(stale.exitCode).toBe(1);
      expect(output(stale)).toContain("incident.json is out of date");
      expect(readFileSync(join(builder, "incident.json"), "utf8")).toBe("{}\n");
    },
    { timeout: 20_000 },
  );

  test("binds workItem.description into the start args", async () => {
    const { root, builder, home } = project({ "described.ts": DESCRIPTION });

    const result = await build(root, home);

    expect(result.exitCode).toBe(0);
    const document = JSON.parse(
      readFileSync(join(builder, "described.json"), "utf8"),
    ) as { start: unknown };
    expect(document.start).toEqual({
      to: "triage",
      args: { title: "workItem.title", description: "workItem.description" },
    });
  });

  test("a definePipeline build error prints its TS location", async () => {
    const { root, home } = project({ "wired-twice.ts": BUILD_ERROR });

    const result = await build(root, home);

    expect(result.exitCode).toBe(1);
    expect(output(result)).toMatch(
      /wired-twice\.ts:\d+ \(\/[^)]*\): .*classify/,
    );
  });

  test("a validatePipeline error prints its TS location", async () => {
    const { root, builder, home } = project({
      "not-dominated.ts": VALIDATION_ERROR,
    });

    const result = await build(root, home);

    expect(result.exitCode).toBe(1);
    expect(output(result)).toMatch(
      /not-dominated\.ts:10 \(\/nodes\/ticket\/next\/routes\/0\/args\/critical\): .*classify/,
    );
    expect(existsSync(join(builder, "not-dominated.json"))).toBe(true);
  });

  test("an unknown stepRef asks to log in or define the step", async () => {
    const { root, home } = project({ "remote.ts": STEP_REF });

    const result = await build(root, home);

    expect(result.exitCode).toBe(1);
    expect(output(result)).toContain('Step "server-only" isn\'t defined');
    expect(output(result)).toContain("scarn auth login");
  });

  test("ignores old-shape pipeline exports and reports no pipelines", async () => {
    const { root, builder, home } = project({ "old.ts": OLD_SDK });

    const result = await build(root, home);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain("No pipelines found");
    expect(existsSync(join(builder, "old.json"))).toBe(false);
  });

  test("names a file that fails to import", async () => {
    const { root, home } = project({
      "broken.ts": `throw new Error("kaboom");\n`,
      "incident.ts": VALID,
    });

    const result = await build(root, home, [join(BUILDER, "broken.ts")]);

    expect(result.exitCode).toBe(1);
    expect(output(result)).toContain("broken.ts failed to build");
    expect(output(result)).toContain("kaboom");
  });
});
