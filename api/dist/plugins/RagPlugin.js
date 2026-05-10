/**
 * RAG plugin for CommonToolFactory: search_knowledge_base tool and dynamic prompt context.
 * All access scoped by org_id.
 */
import * as vectorRepo from "../db/vectorRepo.js";
const DEFAULT_SEARCH_LIMIT = 5;
export function createRagPlugin(embeddingService, orgId) {
    return {
        type: "function",
        function: {
            name: "search_knowledge_base",
            description: "Search the organisation's knowledge base for relevant information. Use this when the user asks a question that might be in the knowledge base.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    limit: { type: "number", description: "Max number of chunks to return (default 5)" },
                },
                required: ["query"],
            },
        },
        impl: async (args) => {
            const query = args?.query ?? "";
            const limit = Math.min(20, Math.max(1, args?.limit ?? DEFAULT_SEARCH_LIMIT));
            if (!query.trim()) {
                return { chunks: [], error: "query is required" };
            }
            try {
                const embeddingCfg = await embeddingService.getConfig(orgId);
                const embedding = await embeddingService.embedQuery(orgId, query);
                const rows = await vectorRepo.searchChunks(orgId, embedding, embeddingCfg.dimensions, embeddingCfg.model, limit);
                return {
                    chunks: rows.map((r) => r.content_text),
                    count: rows.length,
                };
            }
            catch (e) {
                return { chunks: [], error: e?.message ?? String(e) };
            }
        },
        finalise: async (ctx) => {
            return null;
        },
        promptInjection: "When the user asks about something that might be in the knowledge base, use the search_knowledge_base tool to retrieve relevant excerpts before answering.",
    };
}
