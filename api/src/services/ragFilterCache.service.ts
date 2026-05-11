import * as vectorRepo from "../db/vectorRepo.js";
import type { SlackUserOption } from "../db/vectorRepo.js";
import { logger } from "../logger.js";

const DEFAULT_TTL_MS = 90_000;

type Entry<T> = { value: T; storedAt: number };

const channelsByOrg = new Map<string, Entry<string[]>>();
const usersByOrg = new Map<string, Entry<SlackUserOption[]>>();

function ttlMs(): number {
    const raw = process.env.RAG_FILTER_CACHE_TTL_MS;
    if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 1000) return n;
    }
    return DEFAULT_TTL_MS;
}

export function invalidateRagFilterCache(orgId: string, reason: string): void {
    const hadChannels = channelsByOrg.has(orgId);
    const hadUsers = usersByOrg.has(orgId);
    channelsByOrg.delete(orgId);
    usersByOrg.delete(orgId);
    logger.debug(
        { orgId, reason, hadChannels, hadUsers },
        "rag filter cache: invalidated"
    );
}

export async function getCachedSlackChannels(orgId: string): Promise<string[]> {
    const ttl = ttlMs();
    const hit = channelsByOrg.get(orgId);
    if (hit && Date.now() - hit.storedAt < ttl) {
        logger.debug(
            { orgId, kind: "channels", cacheHit: true, ageMs: Date.now() - hit.storedAt, count: hit.value.length },
            "rag filter cache"
        );
        return hit.value;
    }
    logger.debug({ orgId, kind: "channels", cacheHit: false }, "rag filter cache");
    const value = await vectorRepo.listDistinctSlackChannels(orgId);
    channelsByOrg.set(orgId, { value, storedAt: Date.now() });
    logger.debug({ orgId, kind: "channels", loadedCount: value.length }, "rag filter cache: stored");
    return value;
}

export async function getCachedSlackUsers(orgId: string): Promise<SlackUserOption[]> {
    const ttl = ttlMs();
    const hit = usersByOrg.get(orgId);
    if (hit && Date.now() - hit.storedAt < ttl) {
        logger.debug(
            { orgId, kind: "users", cacheHit: true, ageMs: Date.now() - hit.storedAt, count: hit.value.length },
            "rag filter cache"
        );
        return hit.value;
    }
    logger.debug({ orgId, kind: "users", cacheHit: false }, "rag filter cache");
    const value = await vectorRepo.listDistinctSlackUsers(orgId);
    usersByOrg.set(orgId, { value, storedAt: Date.now() });
    logger.debug({ orgId, kind: "users", loadedCount: value.length }, "rag filter cache: stored");
    return value;
}
