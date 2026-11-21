/**
 * Type that maps T to a string-embeddable proxy shape.
 * `-?` strips optionality so `input.user?.email` and `input.user.email` both work —
 * the proxy is never nullish, so optional chaining is a no-op at definition time.
 * `& string` lets each node embed in template literals (`${input.title}`).
 */
export type PromptInputProxy<T> = {
  [K in keyof T]-?: PromptInputProxy<NonNullable<T[K]>>;
} & string;

export type PromptTemplateContext<
  TInput,
  TPromptEnv = PromptInputProxy<Record<string, string | undefined>>,
> = {
  input: PromptInputProxy<TInput>;
  env: TPromptEnv;
  scarn: {
    artifactsDir: string;
  };
};

/**
 * Reading this key from a token proxy returns its path (`["input", "title"]`);
 * on any other value it reads `undefined`. Lets a walker tell a bare proxy
 * from a real value.
 */
export const PROMPT_TOKEN_PATH: unique symbol = Symbol("scarn.promptTokenPath");

/** The token path of a proxy made by `createPromptInputProxy`, else `undefined`. */
export function promptTokenPathOf(
  // eslint-disable-next-line local/no-unknown-parameter-type
  value: unknown,
): readonly string[] | undefined {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return undefined;
  }
  const path = (value as { [PROMPT_TOKEN_PATH]?: unknown })[PROMPT_TOKEN_PATH];
  return Array.isArray(path) ? (path as string[]) : undefined;
}

/**
 * How a proxy reacts to being used as more than a token. `onMisuse`
 * receives a description of the misuse and must throw; when omitted the
 * proxy is lenient (every coercion yields the token), as prompts need.
 */
export type PromptInputProxyOptions = {
  readonly onMisuse?: (token: string, misuse: string) => never;
};

export function createPromptInputProxy<T>(
  path: string[] = [],
  options: PromptInputProxyOptions = {},
): PromptInputProxy<T> {
  const token = () => (path.length ? `{{${path.join(".")}}}` : "");
  const { onMisuse } = options;

  if (onMisuse === undefined) {
    return new Proxy(Object.freeze({}), {
      get(_, key) {
        if (key === PROMPT_TOKEN_PATH) return [...path];
        if (key === Symbol.toPrimitive || key === "valueOf") {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          return (_hint: string) => token();
        }
        if (key === "toString") {
          return () => token();
        }
        if (typeof key !== "string") return undefined;
        return createPromptInputProxy([...path, key]);
      },
    }) as unknown as PromptInputProxy<T>;
  }

  return new Proxy(() => undefined, {
    get(_, key) {
      if (key === PROMPT_TOKEN_PATH) return [...path];
      if (key === Symbol.toPrimitive) {
        return (hint: string) =>
          hint === "string"
            ? token()
            : onMisuse(
                token(),
                `used as a ${hint === "number" ? "number" : "value"} (arithmetic, comparison or \`+\`)`,
              );
      }
      if (key === "toString") {
        return () => token();
      }
      if (key === Symbol.iterator) {
        return onMisuse(token(), "iterated or spread as an array");
      }
      if (typeof key !== "string") return undefined;
      return createPromptInputProxy([...path, key], options);
    },
    apply() {
      const name = path.at(-1) ?? "";
      return onMisuse(
        `{{${path.slice(0, -1).join(".")}}}`,
        `called with \`.${name}()\``,
      );
    },
    ownKeys() {
      return onMisuse(token(), "spread or enumerated");
    },
  }) as unknown as PromptInputProxy<T>;
}

export function createPromptTemplateContext<
  TInput,
  TPromptEnv = PromptInputProxy<Record<string, string | undefined>>,
>(): PromptTemplateContext<TInput, TPromptEnv> {
  return {
    input: createPromptInputProxy(["input"]),
    env: createPromptInputProxy(["env"]) as unknown as TPromptEnv,
    scarn: {
      artifactsDir: createPromptInputProxy(["scarn", "artifactsDir"]),
    },
  };
}

/**
 * Renders a prompt template string by replacing `{{dot.path}}` tokens with
 * values resolved from the provided context object. Missing or null values
 * are replaced with an empty string.
 */
export function renderPromptTemplate(
  template: string,
  // eslint-disable-next-line local/no-unknown-parameter-type
  contextJson: unknown,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (curr, key) =>
          curr != null ? (curr as Record<string, unknown>)[key] : undefined,
        contextJson,
      );
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return value != null ? String(value) : "";
  });
}
