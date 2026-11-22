/**
 * A secret value as stored at rest: the output of `SecretCipher.encrypt`.
 * `keyVersion` says which encryption key produced it.
 */
export type EncryptedSecretValue = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
};
