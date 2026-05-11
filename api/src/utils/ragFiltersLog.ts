import type { RagChunkSearchFilters } from "../types/ragFilters.js";

/** Compact, safe-for-logs summary (truncated lists). */
export function summarizeRagChunkSearchFilters(filters?: RagChunkSearchFilters): Record<string, unknown> {
    if (!filters) {
        return { ragFiltersActive: false };
    }
    return {
        ragFiltersActive: true,
        timeFrom: filters.timeFrom?.toISOString(),
        timeToExclusive: filters.timeToExclusive?.toISOString(),
        channelCount: filters.channels?.length ?? 0,
        channelsPreview: filters.channels?.slice(0, 8),
        userIdCount: filters.userIds?.length ?? 0,
        userIdsPreview: filters.userIds?.slice(0, 8),
    };
}
