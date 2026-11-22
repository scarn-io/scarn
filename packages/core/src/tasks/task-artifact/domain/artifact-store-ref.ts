/**
 * Build the fully-qualified store reference for an artifact object key.
 *
 * When the object-storage bucket is known we emit the canonical
 * `s3://<bucket>/<objectKey>` form (matching how log archives are addressed).
 * When the bucket is not available (e.g. object storage not configured, or a
 * test store) we fall back to the bare object key so the reference is still
 * meaningful and stable. Bucket sourcing is an injected concern (see di.ts) so
 * the application layer never reads the environment directly.
 */
export const buildArtifactStoreRef = (
  bucket: string | null | undefined,
  objectKey: string,
): string => (bucket ? `s3://${bucket}/${objectKey}` : objectKey);
