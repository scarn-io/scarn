import { openapi } from "@elysia/openapi";

export const openApiPlugin = openapi({
  documentation: {
    info: {
      title: "Scarn API",
      version: "0.0.0",
    },
  },
  exclude: {
    methods: ["options", "head"],
  },
});

export type OpenApiPlugin = typeof openApiPlugin;
