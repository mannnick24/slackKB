import { randomUUID } from "node:crypto";
import type { IngestResult } from "./ingest.service.js";

export type IngestJobPublicStatus = "queued" | "running" | "completed" | "failed";

/** Snapshot returned by GET …/jobs/:id/progress */
export interface IngestJobSnapshot {
    jobId: string;
    status: IngestJobPublicStatus;
    stage: string;
    /** 0–100; best effort when total work is unknown */
    percent: number;
    filename?: string;
    ingestMode?: string;
    filesProcessed?: number;
    chunksStored?: number;
    /** Present when status is `completed` */
    result?: {
        filesProcessed: number;
        chunksStored: number;
        skippedDuplicates: number;
        warnings?: string[];
        errors?: string[];
    };
    /** Present when status is `failed` */
    error?: string;
    details?: string[];
}

interface InternalJob extends IngestJobSnapshot {
    createdAt: number;
    /** Timeout handle to drop finished jobs from memory */
    disposeTimer?: ReturnType<typeof setTimeout>;
}

const TTL_MS_AFTER_DONE = 60 * 60 * 1000;

const jobs = new Map<string, InternalJob>();

function scheduleDispose(jobId: string) {
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.disposeTimer) clearTimeout(job.disposeTimer);
    job.disposeTimer = setTimeout(() => {
        jobs.delete(jobId);
    }, TTL_MS_AFTER_DONE);
}

export function createIngestJob(meta: { filename: string; ingestMode: string }): string {
    const jobId = randomUUID();
    const now = Date.now();
    jobs.set(jobId, {
        jobId,
        status: "queued",
        stage: "Queued",
        percent: 0,
        filename: meta.filename,
        ingestMode: meta.ingestMode,
        filesProcessed: 0,
        chunksStored: 0,
        createdAt: now,
    });
    return jobId;
}

export function ingestJobStart(jobId: string): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.stage = "Starting";
    job.percent = Math.max(job.percent, 1);
}

export function ingestJobProgress(
    jobId: string,
    patch: Partial<Pick<IngestJobSnapshot, "stage" | "percent" | "filesProcessed" | "chunksStored">>
): void {
    const job = jobs.get(jobId);
    if (!job || job.status === "completed" || job.status === "failed") return;
    if (patch.stage !== undefined) job.stage = patch.stage;
    if (patch.percent !== undefined) job.percent = Math.min(100, Math.max(0, patch.percent));
    if (patch.filesProcessed !== undefined) job.filesProcessed = patch.filesProcessed;
    if (patch.chunksStored !== undefined) job.chunksStored = patch.chunksStored;
}

export function ingestJobComplete(jobId: string, result: IngestResult, warnings: string[] | undefined): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.stage = "Done";
    job.percent = 100;
    job.filesProcessed = result.filesProcessed;
    job.chunksStored = result.chunksStored;
    job.result = {
        filesProcessed: result.filesProcessed,
        chunksStored: result.chunksStored,
        skippedDuplicates: result.skippedDuplicates,
        warnings: warnings && warnings.length > 0 ? warnings : undefined,
        errors: result.errors.length > 0 ? result.errors : undefined,
    };
    scheduleDispose(jobId);
}

export function ingestJobFail(jobId: string, message: string, details?: string[]): void {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.stage = "Failed";
    job.percent = 100;
    job.error = message;
    job.details = details;
    scheduleDispose(jobId);
}

export function getIngestJob(jobId: string): IngestJobSnapshot | undefined {
    const job = jobs.get(jobId);
    if (!job) return undefined;
    const { disposeTimer: _t, createdAt: _c, ...rest } = job;
    return rest;
}
