import { describe, expect, test } from "bun:test";
import {
  argsTemplateTokens,
  assertArgsTemplateFitsEnvironment,
  compileArgsTemplate,
  renderArgsTemplate,
} from "../src/definitions/steps/args-template";
import { createPromptInputProxy } from "../src/definitions/steps/prompt-template";
import { AuthoringError } from "../src/pipelines/errors";

type Input = {
  title: string;
  count: number;
  tags: string[];
  owner: { id: string; email?: string | null };
};
type Env = { BASE_URL: string; PAGE: string };

function compile(fn: (ctx: { input: Input; env: Env }) => unknown) {
  return compileArgsTemplate<Input, Env, unknown>(fn, {
    stepKey: "notion-search",
  });
}

function compileError(fn: (ctx: { input: Input; env: Env }) => unknown) {
  try {
    compile(fn);
  } catch (error) {
    return error;
  }
  throw new Error("expected compile to throw");
}

describe("compileArgsTemplate", () => {
  test("turns bare proxies into exact tokens and literals into JSON", () => {
    const template = compile(({ input, env }) => ({
      query: input.title,
      limit: input.count,
      tags: input.tags,
      owner: input.owner,
      parent: { page_id: env.PAGE },
      flags: [true, 3, null, "x", input.owner.id],
    }));

    expect(template).toEqual({
      query: "{{input.title}}",
      limit: "{{input.count}}",
      tags: "{{input.tags}}",
      owner: "{{input.owner}}",
      parent: { page_id: "{{env.PAGE}}" },
      flags: [true, 3, null, "x", "{{input.owner.id}}"],
    });
  });

  test("keeps tokens inside template literals as interpolated text", () => {
    const template = compile(({ input, env }) => ({
      title: `Bug: ${input.title} (${input.owner.id})`,
      url: `${env.BASE_URL}/pages`,
    }));

    expect(template).toEqual({
      title: "Bug: {{input.title}} ({{input.owner.id}})",
      url: "{{env.BASE_URL}}/pages",
    });
  });

  test("accepts a whole-input proxy and literal token strings", () => {
    expect(compile(({ input }) => input)).toBe("{{input}}");
    expect(compile(() => ({ n: "{{input.count}}" }))).toEqual({
      n: "{{input.count}}",
    });
  });

  test("drops undefined object values and rejects undefined array items", () => {
    expect(compile(() => ({ a: 1, b: undefined }))).toEqual({ a: 1 });
    expect(compileError(() => [1, undefined])).toBeInstanceOf(AuthoringError);
    expect(compileError(() => undefined)).toBeInstanceOf(AuthoringError);
  });

  test.each([
    ["arithmetic", ({ input }: { input: Input }) => ({ n: input.count + 1 })],
    [
      "string concatenation with +",
      ({ input }: { input: Input }) => ({ s: "Bug: " + input.title }),
    ],
    ["comparison", ({ input }: { input: Input }) => ({ b: input.count > 3 })],
    [
      "a method call",
      ({ input }: { input: Input }) => ({ s: input.title.toUpperCase() }),
    ],
    [
      "an array method",
      ({ input }: { input: Input }) => ({ t: input.tags.map((t) => t) }),
    ],
    [
      "an array spread",
      ({ input }: { input: Input }) => ({ t: [...input.tags] }),
    ],
    [
      "an object spread",
      ({ input }: { input: Input }) => ({ ...input.owner, extra: 1 }),
    ],
    [
      "Math.max()",
      ({ input }: { input: Input }) => ({ n: Math.max(input.count, 0) }),
    ],
  ])("traps %s and points to codeStep", (_, fn) => {
    const error = compileError(fn);
    expect(error).toBeInstanceOf(AuthoringError);
    expect((error as Error).message).toContain('Step "notion-search" args');
    expect((error as Error).message).toContain("codeStep");
  });

  test("rejects values that are not JSON", () => {
    expect(compileError(() => ({ d: new Date(0) }))).toBeInstanceOf(
      AuthoringError,
    );
    expect(compileError(() => ({ f: () => 1 }))).toBeInstanceOf(AuthoringError);
    expect(compileError(() => ({ n: Number.NaN }))).toBeInstanceOf(
      AuthoringError,
    );
  });

  test("rejects tokens outside input and single env vars", () => {
    expect(
      (compileError(() => ({ dir: "{{scarn.artifactsDir}}" })) as Error)
        .message,
    ).toContain("only {{input.…}} and {{env.NAME}}");
    expect(
      (compileError(({ env }) => ({ e: env })) as Error).message,
    ).toContain("exactly one var");
  });

  test("leaves prompt proxies lenient", () => {
    const proxy = createPromptInputProxy<{ n: number }>(["input"]);
    expect(String(+proxy.n)).toBe("NaN");
  });
});

describe("renderArgsTemplate", () => {
  const context = {
    input: {
      title: "Checkout bug",
      count: 3,
      tags: ["a", "b"],
      owner: { id: "u1", email: null },
    },
    env: { PAGE: "abc123" },
  };

  test("an exact token keeps the value's type", () => {
    expect(
      renderArgsTemplate(
        {
          limit: "{{input.count}}",
          tags: "{{input.tags}}",
          owner: "{{input.owner}}",
          page: "{{ env.PAGE }}",
          nested: [{ id: "{{input.owner.id}}" }],
          literal: 7,
        },
        context,
      ),
    ).toEqual({
      limit: 3,
      tags: ["a", "b"],
      owner: { id: "u1", email: null },
      page: "abc123",
      nested: [{ id: "u1" }],
      literal: 7,
    });
  });

  test("tokens inside longer strings interpolate as text", () => {
    expect(
      renderArgsTemplate(
        {
          title: "Bug: {{input.title}} x{{input.count}}",
          email: "<{{input.owner.email}}>",
          missing: "[{{input.nope}}]",
          tags: "tags={{input.tags}}",
        },
        context,
      ),
    ).toEqual({
      title: "Bug: Checkout bug x3",
      email: "<>",
      missing: "[]",
      tags: 'tags=["a","b"]',
    });
  });

  test("a missing exact token drops the key, or is null in arrays and at the top", () => {
    expect(
      renderArgsTemplate(
        {
          present: "{{input.title}}",
          gone: "{{input.nope}}",
          nullish: "{{input.owner.email}}",
          list: ["{{input.nope}}"],
        },
        context,
      ),
    ).toEqual({ present: "Checkout bug", nullish: null, list: [null] });
    expect(renderArgsTemplate("{{input.nope}}", context)).toBeNull();
  });

  test("renders a compiled template end to end", () => {
    const template = compile(({ input, env }) => ({
      parent: { page_id: env.PAGE },
      pages: [{ title: `Bug: ${input.title}`, count: input.count }],
    }));
    expect(renderArgsTemplate(template, context)).toEqual({
      parent: { page_id: "abc123" },
      pages: [{ title: "Bug: Checkout bug", count: 3 }],
    });
  });
});

describe("argsTemplateTokens", () => {
  test("lists every token in order, through nesting", () => {
    expect(
      argsTemplateTokens({
        a: "{{input.title}} and {{ env.PAGE }}",
        b: [{ c: "{{input.count}}" }, 1, null],
        d: "plain",
      }),
    ).toEqual(["input.title", "env.PAGE", "input.count"]);
  });
});

describe("assertArgsTemplateFitsEnvironment", () => {
  const template = { a: "{{env.PAGE}}", b: "{{env.TOKEN}}" };

  test("passes declared non-secret vars and unknown environments", () => {
    expect(() => {
      assertArgsTemplateFitsEnvironment({ a: "{{env.PAGE}}" }, [
        { name: "PAGE", source: "value", secret: false },
      ]);
    }).not.toThrow();
    expect(() => {
      assertArgsTemplateFitsEnvironment(template, undefined);
    }).not.toThrow();
  });

  test("rejects undeclared and secret vars", () => {
    expect(() => {
      assertArgsTemplateFitsEnvironment(template, [
        { name: "PAGE", source: "value", secret: false },
      ]);
    }).toThrow("{{env.TOKEN}} names a var the environment does not declare");
    expect(() => {
      assertArgsTemplateFitsEnvironment(
        template,
        [
          { name: "PAGE", source: "inherit", secret: true },
          { name: "TOKEN", source: "secret" },
        ],
        { stepKey: "s" },
      );
    }).toThrow(
      /^Step "s" args: \{\{env\.PAGE\}\} names a secret var.*\{\{env\.TOKEN\}\} names a secret var/,
    );
  });
});
