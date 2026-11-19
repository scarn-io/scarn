export const makeJwt = (expSecondsFromNow: number, id = "t") => {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  return `${encode({ alg: "EdDSA" })}.${encode({ exp, jti: id })}.sig`;
};

export const jsonResponse = (status: number, body?: object) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const rejectionOf = (promise: Promise<string>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    // eslint-disable-next-line local/no-unknown-parameter-type
    (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
  );
