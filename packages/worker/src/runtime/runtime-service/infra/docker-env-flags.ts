/**
 * `docker exec` env flags that name each variable (`-e NAME`) without its
 * value, plus the `env` record the `docker` CLI process must run with so it can
 * resolve those names. Values therefore never appear in argv (and so never in
 * `ps` output or exec error messages).
 *
 * Layers are applied in order and later layers win (provider env, then step
 * env); each name is flagged once.
 */
export type DockerEnvByName = {
  flags: string[];
  env: Record<string, string>;
};

export function buildDockerEnvByName(
  ...layers: ReadonlyArray<Readonly<Record<string, string>> | undefined>
): DockerEnvByName {
  const env: Record<string, string> = {};
  for (const layer of layers) Object.assign(env, layer);
  return {
    flags: Object.keys(env).flatMap((name) => ["-e", name]),
    env,
  };
}

/**
 * The environment for a `docker` CLI child process: the worker's own
 * environment (PATH, DOCKER_HOST, …) with the by-name values layered on top.
 */
export function dockerProcessEnv(
  byName: DockerEnvByName,
): Record<string, string | undefined> {
  return { ...process.env, ...byName.env };
}
