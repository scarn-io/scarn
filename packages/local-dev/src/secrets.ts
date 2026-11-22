/**
 * Saves the sandbox's project secrets, creating each one or replacing its
 * value, so every seed leaves the same values that the `local-secrets`
 * environment reads.
 */
import { createScarnClient } from "@scarn/sdk";
import type { LocalDevAuth } from "./auth";

export interface LocalSecret {
  name: string;
  value: string;
}

function failure(
  context: string,
  result: { error?: unknown; response?: Response },
): Error {
  const status = result.response ? ` (${String(result.response.status)})` : "";
  return new Error(
    `[local-dev] ${context} failed${status}: ${JSON.stringify(result.error)}`,
  );
}

export async function seedSecrets(input: {
  auth: LocalDevAuth;
  projectId: string;
  secrets: LocalSecret[];
}): Promise<void> {
  const { auth, projectId, secrets } = input;
  const api = createScarnClient(auth.origin);

  const listed = await api.projectSecrets.listProjectSecrets({
    path: { projectId },
    headers: auth.headers,
  });
  if (listed.error !== undefined) throw failure("listProjectSecrets", listed);
  const idByName = new Map(listed.data.map((secret) => [secret.name, secret.id]));

  for (const { name, value } of secrets) {
    const secretId = idByName.get(name);
    const result = secretId
      ? await api.projectSecrets.updateProjectSecret({
          path: { projectId, secretId },
          body: { value },
          headers: auth.headers,
        })
      : await api.projectSecrets.createProjectSecret({
          path: { projectId },
          body: { name, value },
          headers: auth.headers,
        });
    if (result.error !== undefined) {
      throw failure(`${secretId ? "update" : "create"} secret ${name}`, result);
    }
  }
}
