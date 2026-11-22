import { v7 as uuidv7, validate as isUuid, version as uuidVersion } from "uuid";

export type AuthId = string & { readonly __brand: "AuthId" };

export const isAuthId = (value: string): value is AuthId =>
  isUuid(value) && uuidVersion(value) === 7;

export const parseAuthId = (value: string): AuthId => {
  const normalizedValue = value.trim();

  if (!isAuthId(normalizedValue)) {
    throw new Error(`Auth id must be a UUID v7: ${value}`);
  }

  return normalizedValue;
};

export const createAuthId = (): AuthId => parseAuthId(uuidv7());
