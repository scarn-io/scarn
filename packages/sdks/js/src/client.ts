import { ScarnClient } from "./generated";
import { createClient } from "./generated/client";

export * from "./task-plane-client";
export * from "./generated/";

export function createScarnClient(baseUrl: string) {
  const client = createClient({ baseUrl });
  return new ScarnClient({ client });
}
