import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";
import { localEslintPlugin } from "./eslint/rules/no-unknown-parameter-type.mjs";
import scarnEslintPlugin from "./packages/sdks/js/src/eslint.ts";

const maxFileLines = 400;

// Hosted-only code lives in `hosted/` and `(hosted)/` folders that the public
// mirror leaves out, so open code must not import from them, nor from the
// private `@scarn/growth` package.
const hostedFolderGlobs = ["**/hosted/**", "**/(hosted)/**"];
const openCodeGlobs = [
  "apps/api/src/**/*.{ts,tsx}",
  "apps/next/**/*.{ts,tsx}",
  "packages/core/**/*.{ts,tsx}",
];
const hostedImportPatterns = [
  {
    group: ["**/hosted", "**/hosted/**", "**/(hosted)", "**/(hosted)/**"],
    message:
      "Open code must not import hosted-only code: the public mirror excludes hosted/ folders.",
  },
  {
    group: ["@scarn/growth", "@scarn/growth/*"],
    message:
      "@scarn/growth is private; only code under a hosted/ folder may import it.",
  },
];
const posthogImportPath = {
  name: "posthog-js",
  message:
    "Import from @scarn/observability/analytics/browser (initialized in components/analytics-provider.tsx) instead of posthog-js directly.",
};

export default defineConfig(
  {
    ignores: [
      "**/.next/**",
      ".next/**",
      "**/.astro/**",
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      // Only the pipeline builder's TypeScript sources are linted.
      ".scarn/*",
      "!.scarn/pipeline-builder/",
      ".scarn/pipeline-builder/*",
      "!.scarn/pipeline-builder/*.ts",
      ".scarn/pipeline-builder/push.ts",
      "packages/local-dev/src/local-test-project/.scarn/pipeline-builder/*",
      "!packages/local-dev/src/local-test-project/.scarn/pipeline-builder/*.ts",
      "packages/local-dev/src/local-test-project/.scarn/pipeline-builder/push.ts",
      "scripts/**",
      // Research evidence snapshots, not part of any tsconfig project.
      "docs/research/**",
      "eslint/rules/**",
      "eslint.config.mjs",
      "**/*.d.ts",
      "**/*.gen.ts",
      "**/*.astro",
      "**/src/generated/**",
      "**/playwright-report/**",
      "**/test-results/**",
      // Static bundle files the artifact-sharing e2e uploads as-is.
      "apps/next/tests/e2e/fixtures/artifact-bundles/**",
      // Astro apps: only have minimal TS shims, no meaningful code to lint
      "apps/docs/**",
      "apps/landing/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import/resolver": {
        typescript: true,
      },
    },
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
      "@next/next": nextPlugin,
      local: localEslintPlugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import/first": "error",
      "import/no-default-export": "off",
      "import/no-duplicates": "error",
      "local/no-unknown-parameter-type": "error",
      "max-lines": [
        "error",
        {
          max: maxFileLines,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "no-console": [
        "error",
        {
          allow: ["warn", "error"],
        },
      ],
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    files: ["apps/next/**/*.{ts,tsx}"],
    settings: {
      next: {
        rootDir: "apps/next",
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: openCodeGlobs,
    ignores: hostedFolderGlobs,
    rules: {
      "no-restricted-imports": ["error", { patterns: hostedImportPatterns }],
    },
  },
  {
    files: ["apps/next/**/*.{ts,tsx}"],
    ignores: [
      "apps/next/components/analytics-provider.tsx",
      ...hostedFolderGlobs,
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [posthogImportPath], patterns: hostedImportPatterns },
      ],
    },
  },
  {
    files: hostedFolderGlobs.map((glob) => `apps/next/${glob}`),
    rules: {
      "no-restricted-imports": ["error", { paths: [posthogImportPath] }],
    },
  },
  {
    // Stored readers freeze the shapes they read (docs/persistence/json-columns.md).
    files: ["**/contracts/*-stored.ts"],
    rules: {
      "local/stored-reader-type-only-imports": "error",
    },
  },
  {
    files: ["**/tests/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/scripts/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // demo-video/src holds CLI/build scripts run via `bun src/*.ts`; console
    // output is their intended interface.
    files: ["packages/demo-video/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // preview-env is a CLI (`bun packages/preview-env/src/cli.ts`) whose
    // console output is its interface, both locally and in CI logs.
    files: ["packages/preview-env/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // In packages/core, test location defines the boundary:
    // colocated src tests are unit-only, while top-level tests are infra-backed.
    files: ["packages/core/tests/**/integration/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*/application/*", "@scarn/*/application/*"],
              message:
                "Integration tests must exercise the public API client boundary. Move direct application-layer tests into non-integration test files.",
            },
            ...hostedImportPatterns,
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "testcontainers",
              message:
                "Colocated src tests are unit tests. Keep container-backed tests under packages/core/tests.",
            },
            {
              name: "@testcontainers/postgresql",
              message:
                "Colocated src tests are unit tests. Keep container-backed tests under packages/core/tests.",
            },
          ],
          patterns: [
            {
              group: ["**/tests", "**/tests/*", "@/lib/db", "@/lib/db/*"],
              message:
                "Colocated src tests are unit tests. Do not depend on shared test infra or the real database from src tests.",
            },
            ...hostedImportPatterns,
          ],
        },
      ],
    },
  },
  {
    // JS/MJS/CJS files don't have a tsconfig project, so type-aware rules
    // must be disabled for them to avoid "parserOptions not set" errors.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Plain CommonJS scripts (not compiled from TS) legitimately need require().
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: [
      ".scarn/pipeline-builder/*.ts",
      "packages/local-dev/src/local-test-project/.scarn/pipeline-builder/*.ts",
      "packages/sdks/js/test/**/*.ts",
    ],
    plugins: { scarn: scarnEslintPlugin },
    rules: {
      "scarn/no-logic-in-pipeline-callbacks": "error",
    },
  },
  {
    // The pipeline builder installs its own dependencies (not part of the
    // workspace), so it is linted without type information.
    files: [
      ".scarn/pipeline-builder/*.ts",
      "packages/local-dev/src/local-test-project/.scarn/pipeline-builder/*.ts",
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      parserOptions: { projectService: false, program: null },
    },
  },
  eslintConfigPrettier,
);
