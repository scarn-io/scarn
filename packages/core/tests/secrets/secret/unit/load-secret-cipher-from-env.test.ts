import { describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { ConfigurationError } from "@/lib/errors";
import {
  LazySecretCipher,
  loadSecretCipherFromEnv,
} from "@/secrets/secret/infra/load-secret-cipher-from-env";
import { concurrentTest } from "tests/utils";

const AAD = "secret:test:user:test";

const loadError = (value: string | undefined): ConfigurationError => {
  try {
    loadSecretCipherFromEnv({ SECRETS_ENCRYPTION_KEY: value });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error("Expected loading the cipher to fail");
};

describe("loadSecretCipherFromEnv", () => {
  concurrentTest("loads a base64 32-byte key as key version 1", () => {
    const cipher = loadSecretCipherFromEnv({
      SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });

    const encrypted = cipher.encrypt("token", AAD);

    expect(encrypted.keyVersion).toBe(1);
    expect(cipher.decrypt(encrypted, AAD)).toBe("token");
  });

  concurrentTest("rejects a missing key", () => {
    expect(loadError(undefined).code).toBe("SECRETS_ENCRYPTION_KEY_NOT_SET");
    expect(loadError("   ").code).toBe("SECRETS_ENCRYPTION_KEY_NOT_SET");
  });

  concurrentTest("rejects a key that is not base64 without echoing it", () => {
    const value = "not base64 at all!!-secret-value";

    const error = loadError(value);

    expect(error.code).toBe("SECRETS_ENCRYPTION_KEY_INVALID");
    expect(error.message).not.toContain(value);
  });

  concurrentTest(
    "rejects a key that does not decode to 32 bytes without echoing it",
    () => {
      for (const length of [16, 31, 33, 64]) {
        const value = randomBytes(length).toString("base64");

        const error = loadError(value);

        expect(error.code).toBe("SECRETS_ENCRYPTION_KEY_INVALID");
        expect(error.message).not.toContain(value);
      }
    },
  );
});

describe("LazySecretCipher", () => {
  concurrentTest("does not resolve its cipher until first used", () => {
    let resolved = 0;
    const lazy = new LazySecretCipher(() => {
      resolved += 1;
      return loadSecretCipherFromEnv({
        SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      });
    });

    expect(resolved).toBe(0);
    const encrypted = lazy.encrypt("token", AAD);
    expect(lazy.decrypt(encrypted, AAD)).toBe("token");
    expect(resolved).toBe(1);
  });
});
