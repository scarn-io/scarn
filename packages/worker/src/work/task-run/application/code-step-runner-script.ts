/**
 * The runner script `execute-code-step.ts` writes next to a code step's module
 * and executes inside the workspace. Written as a standalone `.mjs` so it
 * works verbatim under either `bun` or `node`'s ESM loader. Prefers `bun` when
 * present because code-step modules are typically authored in TypeScript (the
 * same `.scarn/pipeline-builder/*.ts` files `@scarn/sdk` collects them
 * from) and `bun`'s `import()` handles `.ts` natively; a devcontainer that only
 * has plain `node` (no TS loader) surfaces a clear import error for a `.ts`
 * module.
 *
 * The script imports the module, then asks `@scarn/sdk/code-step-lookup`
 * (the same discovery the push-time collector uses) for the code step with the
 * given key among the module's named exports. It must live beside the user's
 * module so that the
 * bare `@scarn/sdk/code-step-lookup` import resolves by walking up from the
 * same directory as the module's own imports do.
 *
 * The step function is called as `fn(inputJson, { artifactsDir, fail })`; the
 * folder is created first so the step can write files there and return their
 * paths with `Artifact.path(...)`. `fail` throws a `StepError` built here, so
 * it works whatever SDK version the module bundles. One-argument steps simply
 * ignore the context.
 *
 * When `fn` throws a `StepError` (recognised by its
 * `Symbol.for("scarn.stepError")` brand, so one from any copy of the SDK
 * counts), the runner also writes `{ name, code, message }` to the error file
 * for `execute-code-step.ts` to report as the Task's error.
 *
 * argv: `<entrypointAbsPath> <stepKey> <inputFileAbsPath> <findingsFileAbsPath> <artifactsDirAbsPath> <errorFileAbsPath>`.
 * Every failure is an exit code of 1 with a message on stderr.
 */
export const CODE_STEP_RUNNER_SCRIPT_SOURCE = `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STEP_ERROR_BRAND = Symbol.for("scarn.stepError");

function describeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function isStepError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    error[STEP_ERROR_BRAND] === true &&
    typeof error.name === "string"
  );
}

function fail(name, message, options = {}) {
  const error = new Error(
    message,
    options.cause === undefined ? undefined : { cause: options.cause },
  );
  Object.defineProperty(error, "name", { value: name, configurable: true });
  error.code = options.code;
  error[STEP_ERROR_BRAND] = true;
  throw error;
}

async function writeStepError(errorFilePath, error) {
  const record = {
    name: error.name,
    code: typeof error.code === "string" ? error.code : null,
    message: typeof error.message === "string" ? error.message : String(error),
  };
  try {
    await mkdir(path.dirname(errorFilePath), { recursive: true });
    await writeFile(errorFilePath, JSON.stringify(record), "utf8");
  } catch (writeError) {
    console.error(
      \`scarn code-step runner: failed to write the step error to \${errorFilePath}: \${describeError(writeError)}\`,
    );
  }
}

async function readInstalledSdkVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const raw = await readFile(
        path.join(dir, "node_modules", "@scarn", "sdk", "package.json"),
        "utf8",
      );
      const version = JSON.parse(raw).version;
      return typeof version === "string" ? version : "unknown";
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return "not installed";
      dir = parent;
    }
  }
}

async function main() {
  const [
    ,
    ,
    entrypointPath,
    stepKey,
    inputFilePath,
    findingsFilePath,
    artifactsDir,
    errorFilePath,
  ] = process.argv;
  if (
    !entrypointPath ||
    !stepKey ||
    !inputFilePath ||
    !findingsFilePath ||
    !artifactsDir ||
    !errorFilePath
  ) {
    console.error("scarn code-step runner: missing required arguments");
    process.exitCode = 1;
    return;
  }

  let inputJson;
  try {
    const rawInput = await readFile(inputFilePath, "utf8");
    inputJson = JSON.parse(rawInput);
  } catch (error) {
    console.error(
      \`scarn code-step runner: failed to read/parse input file at \${inputFilePath}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
    return;
  }

  let mod;
  try {
    mod = await import(entrypointPath);
  } catch (error) {
    console.error(
      \`scarn code-step runner: failed to import entrypoint module at \${entrypointPath}: \${describeError(error)}\`,
    );
    process.exitCode = 1;
    return;
  }

  let findCodeStepInModule;
  try {
    ({ findCodeStepInModule } = await import("@scarn/sdk/code-step-lookup"));
  } catch (error) {
    console.error(
      \`scarn code-step runner: the installed @scarn/sdk is too old for inline code steps; upgrade it (installed version: \${
        await readInstalledSdkVersion()
      }; \${error instanceof Error ? error.message : String(error)})\`,
    );
    process.exitCode = 1;
    return;
  }
  if (typeof findCodeStepInModule !== "function") {
    console.error(
      \`scarn code-step runner: the installed @scarn/sdk is too old for inline code steps; upgrade it (installed version: \${
        await readInstalledSdkVersion()
      })\`,
    );
    process.exitCode = 1;
    return;
  }

  let fn;
  try {
    fn = findCodeStepInModule(mod, stepKey);
  } catch (error) {
    console.error(
      \`scarn code-step runner: \${error instanceof Error ? error.message : String(error)}\`,
    );
    process.exitCode = 1;
    return;
  }
  if (typeof fn !== "function") {
    console.error(
      \`scarn code-step runner: no code step with key "\${stepKey}" exported by \${entrypointPath}\`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await mkdir(artifactsDir, { recursive: true });
  } catch (error) {
    console.error(
      \`scarn code-step runner: failed to create the artifacts folder at \${artifactsDir}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await fn(inputJson, { artifactsDir, fail });
  } catch (error) {
    console.error(
      \`scarn code-step runner: code step "\${stepKey}" threw: \${describeError(error)}\`,
    );
    if (isStepError(error)) await writeStepError(errorFilePath, error);
    process.exitCode = 1;
    return;
  }

  try {
    await writeFile(
      findingsFilePath,
      \`\${JSON.stringify({ findingsJson: result === undefined ? null : result }, null, 2)}\\n\`,
      "utf8",
    );
  } catch (error) {
    console.error(
      \`scarn code-step runner: failed to write findings submission to \${findingsFilePath}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
  }
}

await main();
`;
