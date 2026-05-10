export function parseBody(req, schema) {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`Validation error: ${msg}`);
    }
    return parsed.data;
}
