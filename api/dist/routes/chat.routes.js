import { LlmAgentWorker } from "../services/LLMAgentWorker.js";
const worker = new LlmAgentWorker();
function isChatMessages(body) {
    if (!body || typeof body !== "object")
        return false;
    const messages = body.messages;
    if (!Array.isArray(messages))
        return false;
    return messages.every((m) => {
        if (!m || typeof m !== "object")
            return false;
        const role = m.role;
        const content = m.content;
        return typeof role === "string" && typeof content === "string";
    });
}
export async function chatRoutes(app) {
    app.post("/chat/completions", async (req, reply) => {
        if (!isChatMessages(req.body)) {
            return reply.code(400).send({ error: "Expected JSON body: { messages: [{ role, content }] }" });
        }
        const result = await worker.completionFromMessages(req.body.messages);
        try {
            await result.finaliser();
        }
        catch (e) {
            req.log.error({ err: e }, "chat completion finaliser failed");
        }
        if (result.error) {
            return reply.code(502).send({ error: result.error });
        }
        return reply.send({ reply: result.reply });
    });
}
