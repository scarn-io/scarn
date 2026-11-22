import type { EncryptedSecretValue } from "../domain/encrypted-secret-value";

export type { EncryptedSecretValue };

/**
 * Port for encrypting secret values at rest. `aad` (additional authenticated
 * data) is checked but not encrypted: decrypting with a different `aad` than
 * the one used to encrypt fails, which binds a ciphertext to its row and owner.
 * Build it with `secretAad(...)` from the domain.
 */
export interface SecretCipher {
  encrypt(plaintext: string, aad: string): EncryptedSecretValue;
  decrypt(value: EncryptedSecretValue, aad: string): string;
}
