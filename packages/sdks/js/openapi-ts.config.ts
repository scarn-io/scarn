import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../openapi.json",
  output: "src/generated",
  plugins: [
    "@hey-api/typescript",
    {
      name: "@hey-api/sdk",
      operations: {
        containerName: "ScarnClient",
        nesting: (operation) => {
          const [firstTag] = operation.tags ?? [];
          const group = firstTag
            ? `${firstTag.charAt(0).toLowerCase()}${firstTag.slice(1)}`
            : "api";
          return [group, operation.operationId ?? operation.method.toLowerCase()];
        },
        strategy: "single",
      },
    },
    "@hey-api/client-fetch",
  ],
});
