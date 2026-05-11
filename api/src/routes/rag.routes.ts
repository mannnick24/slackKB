import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getCachedSlackChannels, getCachedSlackUsers } from "../services/ragFilterCache.service.js";

export async function ragRoutes(app: FastifyInstance) {
    const orgId = config.defaultOrg;

    app.get("/rag/filters/channels", async (req, reply) => {
        const channels = await getCachedSlackChannels(orgId);
        req.log.debug({ orgId, count: channels.length }, "rag: filters/channels");
        return reply.send({ channels });
    });

    app.get("/rag/filters/users", async (req, reply) => {
        const users = await getCachedSlackUsers(orgId);
        req.log.debug({ orgId, count: users.length }, "rag: filters/users");
        return reply.send({ users });
    });
}
