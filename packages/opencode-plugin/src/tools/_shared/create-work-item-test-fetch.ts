export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Call = { url: string; init: RequestInit | undefined };

/** Test support: a fetch answering with `outcomes` in turn, repeating the last. */
export function fakeFetch(...outcomes: (Response | Error)[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)];
    calls.push({ url, init });
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome?.clone());
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Test support: the API's answer to a create. */
export function created(workItemId = "ignored", isNew = true): Response {
  return new Response(JSON.stringify({ workItemId, created: isNew }), {
    status: isNew ? 201 : 200,
  });
}

/** Test support: the JSON body a call posted. */
export function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(call?.init?.body as string) as Record<string, unknown>;
}
