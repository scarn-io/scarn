/**
 * The durable artifact page, `/projects/<projectId>/artifacts/<artifactId>`.
 * Must match core's `artifactPageUrl`, which posted comments link to.
 */
export const artifactPagePath = (projectId: string, artifactId: string) =>
  `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`;
