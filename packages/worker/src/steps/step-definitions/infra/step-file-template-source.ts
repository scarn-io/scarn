/**
 * Renders stored `{{scope.path}}` templates as JS source for a generated
 * steps file.
 */

export function promptToLiteral(prompt: string): string {
  if (!prompt.includes("\n")) return JSON.stringify(prompt);
  const escaped = prompt
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `\`${escaped}\``;
}

function scopedTokenPattern(scopes: readonly string[]): RegExp {
  return new RegExp(`\\{\\{(${scopes.join("|")})\\.([^}]+)\\}\\}`, "g");
}

export function isValidIdentifier(part: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(part);
}

function promptPathToJsExpr(scope: string, path: string): string {
  return path
    .split(".")
    .filter((part) => part.length > 0)
    .reduce(
      (expr, part) =>
        isValidIdentifier(part)
          ? `${expr}.${part}`
          : `${expr}[${JSON.stringify(part)}]`,
      scope,
    );
}

/**
 * Renders a `{{scope.path}}` template as a JS expression: a plain literal when
 * it holds no token of the given scopes, otherwise a template literal with each
 * token turned into `${scope.path}`. Tokens of any other scope stay literal
 * text. Also reports which scopes the expression reads, so the caller can
 * destructure exactly those.
 */
export function templateToExpr(
  prompt: string,
  scopes: readonly string[],
): { expr: string; usedScopes: string[] } {
  const matches = [...prompt.matchAll(scopedTokenPattern(scopes))];
  if (matches.length === 0) {
    return { expr: promptToLiteral(prompt), usedScopes: [] };
  }

  const usedScopes = new Set(matches.map((match) => match[1]));
  const placeholders = matches.map((match, index) => ({
    token: match[0],
    marker: `__SCARN_PROMPT_EXPR_${String(index)}__`,
    expr: `\${${promptPathToJsExpr(match[1] ?? "", match[2] ?? "")}}`,
  }));

  let template = prompt;
  for (const placeholder of placeholders) {
    template = template.replace(placeholder.token, placeholder.marker);
  }

  template = template
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  for (const placeholder of placeholders) {
    template = template.replaceAll(placeholder.marker, placeholder.expr);
  }

  return {
    expr: `\`${template}\``,
    usedScopes: scopes.filter((scope) => usedScopes.has(scope)),
  };
}
