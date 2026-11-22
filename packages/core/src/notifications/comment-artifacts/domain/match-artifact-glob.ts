const escapeRegExp = (value: string): string =>
  value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Compiles a name or glob relative to `artifactsDir`: `*` matches within a
 * path segment, `?` one character, `**` any number of segments. A pattern
 * without wildcards matches that exact path.
 */
export const compileArtifactGlob = (pattern: string): RegExp => {
  const source = normalizePath(pattern);
  let regex = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === "*" && source.charAt(index + 1) === "*") {
      const followedBySlash = source.charAt(index + 2) === "/";
      regex += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegExp(char);
    }
  }
  return new RegExp(`^${regex}$`);
};

export const matchesArtifactGlob = (
  pattern: string,
  relativeStorePath: string,
): boolean =>
  compileArtifactGlob(pattern).test(normalizePath(relativeStorePath));
