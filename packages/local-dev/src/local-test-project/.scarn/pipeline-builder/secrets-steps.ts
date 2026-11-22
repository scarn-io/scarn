/**
 * `ld-secrets`'s step. It runs in the named `local-secrets` environment
 * (`secrets-environment.ts`), whose `LOCAL_DEV_API_KEY`
 * variable reads the project secret of the same name. The step prints the
 * value, which the worker masks in the task log, and returns only its length
 * and last four characters so you can match it against the settings page.
 */
import { codeStep } from "@scarn/sdk/definitions/steps";
import { z } from "zod";

import { localSecrets } from "./secrets-environment";

const VAR_NAME = "LOCAL_DEV_API_KEY";

type ProcessLike = { env: Record<string, string | undefined> };

export const checkSecret = codeStep({
  key: "check-secret",
  name: "Check the secret",
  environment: localSecrets,
  inputSchema: z.object({}),
  resultSchema: z.object({ length: z.number(), lastFour: z.string() }),
  fn: () => {
    const { process } = globalThis as { process?: ProcessLike };
    const value = process?.env[VAR_NAME];
    if (!value) {
      throw new Error(`check-secret: ${VAR_NAME} is not set`);
    }
    console.log(`${VAR_NAME}=${value}`);
    return { length: value.length, lastFour: value.slice(-4) };
  },
});
