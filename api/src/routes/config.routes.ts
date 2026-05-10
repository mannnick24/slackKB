import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { config } from "../config.js";

/** Safe for HTTP: same shape as AppConfig but secrets omitted. */
function publicConfig(c: AppConfig) {
  return {
    ...c,
    pg: {
      connectionString: c.pg.connectionString ? "[redacted]" : "",
    },
    encKeyB64: "[redacted]",
    llmConfig: {
      ...c.llmConfig,
      apiKey: c.llmConfig.apiKey ? "[redacted]" : "",
    },
  };
}

export async function configRoutes(app: FastifyInstance) {
  app.get("/config", async (_req, reply) => {
    return reply.send(publicConfig(config));
  });
}
