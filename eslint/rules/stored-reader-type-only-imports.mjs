/**
 * Stored readers (`contracts/*-stored.ts`) freeze the shapes they read, so
 * they may only take types from `@scarn/sdk` and `@scarn/shared-core`, never
 * runtime schemas or enums that can change under them. An import (or
 * re-export) is type-only when it is `import type` / `export type`, or when
 * every specifier is an inline `type` specifier. See
 * `docs/persistence/json-columns.md`.
 */

const restrictedPackages = ["@scarn/sdk", "@scarn/shared-core"];

function isRestrictedSource(source) {
  return restrictedPackages.some(
    (name) => source === name || source.startsWith(`${name}/`),
  );
}

function isTypeOnlyImport(node) {
  if (node.importKind === "type") {
    return true;
  }
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) =>
        specifier.type === "ImportSpecifier" && specifier.importKind === "type",
    )
  );
}

function isTypeOnlyExport(node) {
  if (node.exportKind === "type") {
    return true;
  }
  return (
    node.type === "ExportNamedDeclaration" &&
    node.specifiers.length > 0 &&
    node.specifiers.every((specifier) => specifier.exportKind === "type")
  );
}

const storedReaderTypeOnlyImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Stored readers may only import types from @scarn/sdk and @scarn/shared-core",
    },
    schema: [],
    messages: {
      runtimeImport:
        "Stored readers may only `import type` from {{source}}. Copy the schema or enum into this file and freeze it.",
    },
  },
  create(context) {
    const check = (node, isTypeOnly) => {
      const source = node.source?.value;
      if (typeof source !== "string" || !isRestrictedSource(source)) {
        return;
      }
      if (isTypeOnly(node)) {
        return;
      }
      context.report({ node, messageId: "runtimeImport", data: { source } });
    };
    return {
      ImportDeclaration(node) {
        check(node, isTypeOnlyImport);
      },
      ExportNamedDeclaration(node) {
        check(node, isTypeOnlyExport);
      },
      ExportAllDeclaration(node) {
        check(node, isTypeOnlyExport);
      },
    };
  },
};

export const storedReaderTypeOnlyImportsRules = {
  "stored-reader-type-only-imports": storedReaderTypeOnlyImportsRule,
};
