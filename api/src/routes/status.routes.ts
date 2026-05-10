import type { FastifyInstance } from "fastify";
import { getSystemStatus } from "../services/status.service.js";

export async function statusRoutes(app: FastifyInstance) {
  app.get("/status", async (_req, reply) => {
    const status = await getSystemStatus();
    return reply.send(status);
  });
}
