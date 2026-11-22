const origin = "http://localhost";

const withOriginHeader = (headers?: HeadersInit): Headers => {
  const mergedHeaders = new Headers(headers);
  mergedHeaders.set("origin", origin);
  return mergedHeaders;
};

export const createAuthRequest = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost/api/auth${path}`, {
    ...init,
    headers: withOriginHeader(init.headers),
  });

export const readJson = async <T>(response: Response): Promise<T> => {
  const parsed: unknown = await response.json();
  return parsed as T;
};
