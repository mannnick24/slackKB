import { LlmAgentWorker } from "../services/LLMAgentWorker.js";
import { parseRagFiltersFromBody } from "../services/ragFiltersParse.service.js";
import { summarizeRagChunkSearchFilters } from "../utils/ragFiltersLog.js";
const worker = new LlmAgentWorker();
function isChatCompletionBody(body) {
    if (!body || typeof body !== "object")
        return false;
    const messages = body.messages;
    if (!Array.isArray(messages))
        return false;
    const okMsgs = messages.every((m) => {
        if (!m || typeof m !== "object")
            return false;
        const role = m.role;
        const content = m.content;
        return typeof role === "string" && typeof content === "string";
    });
    if (!okMsgs)
        return false;
    const rf = body.ragFilters;
    if (rf !== undefined && rf !== null && (typeof rf !== "object" || Array.isArray(rf))) {
        return false;
    }
    return true;
}
export async function chatRoutes(app) {
    app.post("/chat/completions", async (req, reply) => {
        if (!isChatCompletionBody(req.body)) {
            return reply
                .code(400)
                .send({ error: "Expected JSON body: { messages: [{ role, content }], ragFilters?: object }" });
        }
        let ragFilters;
        try {
            ragFilters = parseRagFiltersFromBody(req.body.ragFilters);
        }
        catch (e) {
            return reply.code(400).send({ error: e?.message ?? String(e) });
        }
        req.log.debug({
            messageCount: req.body.messages.length,
            ...summarizeRagChunkSearchFilters(ragFilters),
        }, "chat: completions request");
        const result = await worker.completionFromMessages(req.body.messages, { ragFilters });
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
