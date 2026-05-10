import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { logger } from "./logger.js";
import sensible from "@fastify/sensible";
import { chatRoutes } from "./routes/chat.routes.js";
import { configRoutes } from "./routes/config.routes.js";
import { documentsRoutes } from "./routes/documents.routes.js";
import { statusRoutes } from "./routes/status.routes.js";
export async function buildServer() {
    const app = Fastify({ loggerInstance: logger });
    await app.register(cors, {
        origin: config.corsOrigin ?? true,
        credentials: true,
    });
    // Global error handler
    app.setErrorHandler((err, req, reply) => {
        // Example: map validation errors to 400
        if (err.validation) {
            return reply.status(400).send({
                statusCode: 400,
                error: 'Bad Request',
                message: err.message,
                details: err.validation,
            });
        }
        // Default 500
        req.log.error({ err }, 'Unhandled error');
        reply.status(err.statusCode || 500).send({
            statusCode: err.statusCode || 500,
            error: 'Internal Server Error',
            message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
        });
    });
    // 404 handler (optional)
    app.setNotFoundHandler((req, reply) => {
        reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
    });
    await app.register(sensible);
    await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
    await app.register(configRoutes, { prefix: "/api/v1" });
    await app.register(chatRoutes, { prefix: "/api/v1" });
    await app.register(documentsRoutes, { prefix: "/api/v1" });
    await app.register(statusRoutes, { prefix: "/api/v1" });
    // ...
    return app;
}
