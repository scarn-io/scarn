/**
 * Args templates: the JSON form of an MCP tool step's `args` (decision 11
 * of ADR 0014).
 *
 * `compileArgsTemplate` calls the author's `args` function once with token
 * proxies for `input` and `env` and walks the value it returns. A bare proxy
 * becomes an exact token (`"{{input.count}}"`); a proxy embedded in a
 * template literal becomes a token inside a longer string. Anything that
 * needs the real value at define time (arithmetic, method calls, spreads)
 * throws an `AuthoringError` pointing to a `codeStep`.
 *
 * `renderArgsTemplate` fills a template at run time. A string that is
 * exactly one token takes the raw value, so numbers, arrays and objects keep
 * their type; tokens inside a longer string interpolate as text, with a
 * missing or null value rendering as `""`.
 */
import type { JsonValue } from "../../contracts/pipeline-document/json";
import { AuthoringError } from "../../pipelines/errors";
import type { BaseBranchEnvVar } from "../../repo-config";
import { createPromptInputProxy, promptTokenPathOf } from "./prompt-template";

/** A compiled args template: JSON whose strings may hold `{{input.…}}` / `{{env.X}}` tokens. */
export type ArgsTemplate = JsonValue;

/**
 * What an `args` function receives. At the type level `input` and `env` are
 * the real values; at define time they are token proxies.
 */
export type ArgsTemplateContext<TInput, TEnv> = {
  readonly input: TInput;
  readonly env: TEnv;
};

export type ArgsTemplateFn<TInput, TEnv, TArgs> = (
  context: ArgsTemplateContext<TInput, TEnv>,
) => TArgs;

export type CompileArgsTemplateOptions = {
  readonly stepKey?: string;
};

const TOKEN_PATTERN = /\{\{([^}]+)\}\}/g;
const EXACT_TOKEN_PATTERN = /^\{\{([^}]+)\}\}$/;

const CODE_STEP_HINT =
  "args are compiled once into a template, so they can only place input and env values, not transform them. Use a codeStep before this step to compute the value.";

function where(options: CompileArgsTemplateOptions): string {
  return options.stepKey ? `Step "${options.stepKey}" args` : "args";
}

export function compileArgsTemplate<TInput, TEnv, TArgs>(
  fn: ArgsTemplateFn<TInput, TEnv, TArgs>,
  options: CompileArgsTemplateOptions = {},
): ArgsTemplate {
  const onMisuse = (token: string, misuse: string): never => {
    throw new AuthoringError(
      `${where(options)}: ${token} is ${misuse}; ${CODE_STEP_HINT}`,
    );
  };
  const context = {
    input: createPromptInputProxy(["input"], { onMisuse }),
    env: createPromptInputProxy(["env"], { onMisuse }),
  } as unknown as ArgsTemplateContext<TInput, TEnv>;

  const returned: unknown = fn(context);
  const template = toTemplateValue(returned, [], options);
  if (template === undefined) {
    throw new AuthoringError(
      `${where(options)}: the args function returned undefined`,
    );
  }
  for (const path of argsTemplateTokens(template)) {
    assertTokenInScope(path, options);
  }
  return template;
}

function describePointer(pointer: readonly (string | number)[]): string {
  return pointer.length === 0 ? "the returned value" : `"${pointer.join(".")}"`;
}

function toTemplateValue(
  // eslint-disable-next-line local/no-unknown-parameter-type
  value: unknown,
  pointer: readonly (string | number)[],
  options: CompileArgsTemplateOptions,
): JsonValue | undefined {
  const tokenPath = promptTokenPathOf(value);
  if (tokenPath !== undefined) return `{{${tokenPath.join(".")}}}`;

  const fail = (what: string): never => {
    throw new AuthoringError(
      `${where(options)}: ${describePointer(pointer)} is ${what}, which is not JSON`,
    );
  };

  switch (typeof value) {
    case "undefined":
      return undefined;
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : fail(String(value));
    case "bigint":
      return fail("a bigint");
    case "symbol":
      return fail("a symbol");
    case "function":
      return fail("a function");
    case "object":
      break;
  }
  if (value === null) return null;
  if (value instanceof Promise) {
    throw new AuthoringError(
      `${where(options)}: the args function must be synchronous; ${CODE_STEP_HINT}`,
    );
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item, index) => {
      const compiled = toTemplateValue(item, [...pointer, index], options);
      return compiled === undefined
        ? fail(`an array with an undefined item at ${String(index)}`)
        : compiled;
    });
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      `a ${(value as { constructor?: { name?: string } }).constructor?.name ?? "class"} instance`,
    );
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const compiled = toTemplateValue(item, [...pointer, key], options);
    if (compiled !== undefined) result[key] = compiled;
  }
  return result;
}

function assertTokenInScope(
  path: string,
  options: CompileArgsTemplateOptions,
): void {
  const [root, ...rest] = path.split(".");
  if (root === "input") return;
  if (root === "env" && rest.length === 1 && rest[0] !== "") return;
  const reason =
    root === "env"
      ? "env tokens must name exactly one var, as {{env.NAME}}"
      : "only {{input.…}} and {{env.NAME}} tokens are allowed";
  throw new AuthoringError(`${where(options)}: {{${path}}}: ${reason}`);
}

/** Every token path in `template` (`"input.title"`, `"env.BASE_URL"`), in order of appearance. */
export function argsTemplateTokens(template: ArgsTemplate): string[] {
  const tokens: string[] = [];
  const visit = (value: JsonValue): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(TOKEN_PATTERN)) {
        tokens.push((match[1] ?? "").trim());
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(template);
  return tokens;
}

/**
 * Throws when `template` has an `{{env.X}}` token the step's environment
 * doesn't allow: `X` is undeclared, or a secret (secrets reach the server
 * only through its own env or headers). `vars` is `undefined` for an
 * environment known only by name; the server checks that one at publish.
 */
export function assertArgsTemplateFitsEnvironment(
  template: ArgsTemplate,
  vars: readonly BaseBranchEnvVar[] | undefined,
  options: CompileArgsTemplateOptions = {},
): void {
  if (vars === undefined) return;
  const problems: string[] = [];
  for (const path of argsTemplateTokens(template)) {
    const [root, name, ...rest] = path.split(".");
    if (root !== "env" || name === undefined || rest.length > 0) continue;
    const entry = vars.find((candidate) => candidate.name === name);
    if (entry === undefined) {
      problems.push(`{{${path}}} names a var the environment does not declare`);
    } else if (entry.source === "secret" || entry.secret) {
      problems.push(
        `{{${path}}} names a secret var; pass secrets to the MCP server through its env or headers, not through args`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`${where(options)}: ${problems.join("; ")}`);
  }
}

/** The `input` and non-secret `env` values a template renders against. */
export type ArgsTemplateRenderContext = {
  readonly input: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
};

function resolvePath(
  path: string,
  context: ArgsTemplateRenderContext,
): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current != null ? (current as Record<string, unknown>)[key] : undefined,
      context,
    );
}

// eslint-disable-next-line local/no-unknown-parameter-type
function interpolate(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

/**
 * Fills `template` from `context`. An exact-token string takes the raw value
 * (a missing value drops the object key, or becomes `null` in an array or at
 * the top level); other strings interpolate, with objects as JSON.
 */
export function renderArgsTemplate(
  template: ArgsTemplate,
  context: ArgsTemplateRenderContext,
): JsonValue {
  return renderValue(template, context) ?? null;
}

function renderValue(
  value: JsonValue,
  context: ArgsTemplateRenderContext,
): JsonValue | undefined {
  if (typeof value === "string") {
    const exact = EXACT_TOKEN_PATTERN.exec(value);
    if (exact) {
      return resolvePath((exact[1] ?? "").trim(), context) as
        JsonValue | undefined;
    }
    return value.replace(TOKEN_PATTERN, (_, path: string) =>
      interpolate(resolvePath(path.trim(), context)),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context) ?? null);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const rendered = renderValue(item, context);
      if (rendered !== undefined) result[key] = rendered;
    }
    return result;
  }
  return value;
}
