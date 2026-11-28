import {
  findArtifactFields,
  type ArtifactJsonSchemaNode,
} from "@scarn/sdk/contracts/artifacts";

/**
 * Bundle fields: result-schema artifact fields whose stored
 * `x-scarn-artifact` keyword carries a `bundle` object, e.g.
 * `{ "accept": [], "bundle": { "entry": "index.html" }, "share": true }`.
 */
export type BundleField = {
  path: string;
  entry: string;
  share: boolean;
};

/**
 * The declared bundle field at `fieldPath` in a Task's result schema, or
 * null when there is no such artifact field, it sits inside an array, or it
 * is a plain file field. `entry` defaults to `index.html`; `share` defaults
 * to false.
 */
export const findBundleField = (
  resultSchemaJson: ArtifactJsonSchemaNode | null | undefined,
  fieldPath: string,
): BundleField | null => {
  const field = findArtifactFields(resultSchemaJson).find(
    (candidate) => candidate.path === fieldPath,
  );
  if (!field || field.inArray || !field.bundle) return null;
  return { path: field.path, entry: field.bundle.entry, share: field.share };
};
