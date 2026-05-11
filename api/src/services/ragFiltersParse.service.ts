import type { RagChunkSearchFilters } from "../types/ragFilters.js";
import { logger } from "../logger.js";
import { summarizeRagChunkSearchFilters } from "../utils/ragFiltersLog.js";

const MAX_LIST_LEN = 50;

function asTrimmedStrings(arr: unknown): string[] {
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const x of arr) {
        if (typeof x !== "string") continue;
        const t = x.trim();
        if (t) out.push(t);
        if (out.length >= MAX_LIST_LEN) break;
    }
    return out;
}

/**
 * Parse optional `ragFilters` from a chat (or similar) JSON body.
 * @throws Error with a short message if the shape is invalid
 */
export function parseRagFiltersFromBody(raw: unknown): RagChunkSearchFilters | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("ragFilters must be an object");
    }
    const o = raw as Record<string, unknown>;
    const out: RagChunkSearchFilters = {};

    const timeFromRaw = o.timeFrom ?? o.from;
    if (typeof timeFromRaw === "string" && timeFromRaw.trim()) {
        const d = new Date(timeFromRaw);
        if (Number.isNaN(d.getTime())) throw new Error("Invalid timeFrom (expected ISO 8601)");
        out.timeFrom = d;
    }

    const timeToRaw = o.timeToExclusive ?? o.to;
    if (typeof timeToRaw === "string" && timeToRaw.trim()) {
        const d = new Date(timeToRaw);
        if (Number.isNaN(d.getTime())) throw new Error("Invalid timeToExclusive (expected ISO 8601)");
        out.timeToExclusive = d;
    }

    if (o.channels !== undefined) {
        if (!Array.isArray(o.channels)) throw new Error("channels must be an array of strings");
        const ch = asTrimmedStrings(o.channels);
        if (o.channels.length > 0 && ch.length === 0) {
            throw new Error("channels must contain non-empty strings");
        }
        if (ch.length) out.channels = ch;
    }

    if (o.userIds !== undefined) {
        if (!Array.isArray(o.userIds)) throw new Error("userIds must be an array of strings");
        const ids = asTrimmedStrings(o.userIds);
        if (o.userIds.length > 0 && ids.length === 0) {
            throw new Error("userIds must contain non-empty strings");
        }
        if (ids.length) out.userIds = ids;
    }

    if (
        out.timeFrom == null &&
        out.timeToExclusive == null &&
        !out.channels?.length &&
        !out.userIds?.length
    ) {
        logger.debug("rag filters: no usable constraints after parse (empty or invalid fields)");
        return undefined;
    }
    logger.debug(summarizeRagChunkSearchFilters(out), "rag filters: parsed");
    return out;
}
