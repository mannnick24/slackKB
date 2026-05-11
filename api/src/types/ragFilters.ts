/**
 * Optional SQL pre-filters for vector search over rag_chunks.
 * Rows missing Slack metadata do not match channel/user/time constraints.
 */

export type RagChunkSearchFilters = {
    /** Inclusive lower bound on slack_message_at */
    timeFrom?: Date;
    /** Exclusive upper bound (slack_message_at < timeToExclusive) */
    timeToExclusive?: Date;
    /** Slack export channel folder names; OR semantics */
    channels?: string[];
    /** Slack user ids (e.g. U…); OR semantics */
    userIds?: string[];
};

/** Wire format for JSON APIs (ISO 8601 date strings). */
export type RagFiltersPayload = {
    timeFrom?: string;
    timeToExclusive?: string;
    channels?: string[];
    userIds?: string[];
};
