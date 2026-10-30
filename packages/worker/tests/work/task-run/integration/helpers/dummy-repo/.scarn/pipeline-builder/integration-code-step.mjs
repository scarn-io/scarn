export const integrationStep = {
  key: "integration-step",
  name: "Integration Step",
  version: 1,
  kind: "code",
  entrypoint: {
    fn: (input) => ({ summary: "code step ok", node: process.version, input }),
  },
};
