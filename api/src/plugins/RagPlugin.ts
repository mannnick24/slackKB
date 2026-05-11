/**
 * RAG plugin for CommonToolFactory: search_knowledge_base tool and dynamic prompt context.
 * All access scoped by org_id.
 */

import type { AppChatCompletionTool } from "./CommonToolFactory.js";
import type { EmbeddingService } from "../services/embedding.service.js";
import type { RagChunkSearchFilters } from "../types/ragFilters.js";
import * as vectorRepo from "../db/vectorRepo.js";
import { logger } from "../logger.js";
import { summarizeRagChunkSearchFilters } from "../utils/ragFiltersLog.js";

const DEFAULT_SEARCH_LIMIT = 5;

export function createRagPlugin(
    embeddingService: EmbeddingService,
    orgId: string,
    /** When set, both tool search and caller-driven RAG use the same slice of the index */
    ragFilters?: RagChunkSearchFilters
): AppChatCompletionTool {
    return {
        type: "function",
        function: {
            name: "search_knowledge_base",
            description:
                "Search the organisation's knowledge base for relevant information. Use this when the user asks a question that might be in the knowledge base. The server applies any active time/channel/user filters from the chat session to this search.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    limit: { type: "number", description: "Max number of chunks to return (default 5)" },
                },
                required: ["query"],
            },
        },
        impl: async (args: { query?: string; limit?: number }) => {
            const query = args?.query ?? "";
            const limit = Math.min(20, Math.max(1, args?.limit ?? DEFAULT_SEARCH_LIMIT));
            if (!query.trim()) {
                return { chunks: [], error: "query is required" };
            }
            try {
                logger.debug(
                    {
                        orgId,
                        queryChars: query.length,
                        queryPreview: query.slice(0, 120),
                        limit,
                        ...summarizeRagChunkSearchFilters(ragFilters),
                    },
                    "rag tool: search_knowledge_base"
                );
                const embeddingCfg = await embeddingService.getConfig(orgId);
                const embedding = await embeddingService.embedQuery(orgId, query);
                const rows = await vectorRepo.searchChunks(
                    orgId,
                    embedding,
                    embeddingCfg.dimensions,
                    embeddingCfg.model,
                    limit,
                    ragFilters
                );
                logger.debug(
                    {
                        orgId,
                        chunkCount: rows.length,
                        ...summarizeRagChunkSearchFilters(ragFilters),
                    },
                    "rag tool: search_knowledge_base result"
                );
                return {
                    chunks: rows.map((r) => r.content_text),
                    count: rows.length,
                };
            } catch (e: any) {
                return { chunks: [], error: e?.message ?? String(e) };
            }
        },
        finalise: async (ctx: any) => {
            return null;
        },
        promptInjection: "When the user asks about something that might be in the knowledge base, use the search_knowledge_base tool to retrieve relevant excerpts before answering.",
    };
}

