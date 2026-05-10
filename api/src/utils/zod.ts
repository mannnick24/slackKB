import { ZodSchema } from "zod";
import type { FastifyRequest } from "fastify";

export function parseBody<T>(req: FastifyRequest, schema: ZodSchema<T>): T {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Validation error: ${msg}`);
  }
  return parsed.data;
}
