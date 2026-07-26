import { Injectable, Logger, Optional } from '@nestjs/common';
import type { TerminalFrame } from '@ever-works/contracts';
import { config } from '../config';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { UserRepository } from '../database/repositories/user.repository';
import {
    TerminalTranscriptChunkRepository,
    TerminalTranscriptChunkWrite,
} from '../database/repositories/terminal-transcript-chunk.repository';
import {
    ENTITLEMENT_KEYS,
    EntitlementsService,
    RETENTION_FOREVER,
    RETENTION_NONE,
} from '../subscriptions/credits/entitlements.service';
import { redactTerminalText } from './terminal-transcript-redaction';

/** One replayable transcript chunk as returned to a client. */
export interface TerminalTranscriptPageChunk {
    seq: number;
    direction: 'out' | 'in';
    /** Redacted UTF-8 text. */
    text: string;
    createdAt: string;
}

export interface TerminalTranscriptPage {
    runId: string;
    chunks: TerminalTranscriptPageChunk[];
    /** Highest `seq` in this page, or null when the page is empty. */
    lastSeq: number | null;
    /**
     * `true` when the page stopped on a cap (chunk count or byte budget)
     * and the caller should request the next page from `lastSeq + 1`.
     */
    hasMore: boolean;
    /** Total chunks stored for the run (not just this page). */
    total: number;
}

export interface TerminalTranscriptSweepSummary {
    scannedRuns: number;
    prunedRuns: number;
    deletedChunks: number;
    /** Runs left untouched because their plan retains forever. */
    keptForever: number;
}

type RetentionSlot = { days: number; expiresAt: number };

/**
 * Terminal transcript persistence, redaction and retention
 * (streaming-terminal M9 — the founder's D1 decision).
 *
 * D1, verbatim: transcripts persist server-side, **tenant-scoped,
 * secret-redacted, retention-capped**, with "**retention as a plan-tier
 * lever**: forever on top plans, bounded windows on cheap plans".
 *
 * Three responsibilities, one seam:
 *
 *  1. **Persist** — `persistFrames` is called from the internal batch
 *     publish endpoint, the same path the relay already serves. It is
 *     BEST-EFFORT by contract: it never throws, and a storage outage
 *     degrades to "no transcript", never to a broken session. That is
 *     why the API controller fires it without awaiting.
 *  2. **Redact** — every chunk goes through `redactTerminalText` BEFORE
 *     the insert. There is exactly one ingest chokepoint and this is it;
 *     nothing writes to `terminal_transcript_chunks` without passing here.
 *  3. **Retain** — the plan's `terminal-transcript-retention-days`
 *     entitlement decides whether a chunk is written at all (0 = keep
 *     nothing, so we never store what we would immediately have to
 *     delete) and how long `sweepExpired` lets it live (-1 = forever).
 *
 * The run → user → plan lookup is cached per run for
 * `TERMINAL_TRANSCRIPT_RETENTION_CACHE_TTL_MS` (default 60s), because the
 * worker transport flushes a batch roughly every 150ms and the tier
 * cannot meaningfully change mid-session.
 */
@Injectable()
export class TerminalTranscriptService {
    private readonly logger = new Logger(TerminalTranscriptService.name);

    /** runId → resolved retention window, TTL-bounded. */
    private readonly retentionCache = new Map<string, RetentionSlot>();

    /** Bound on the cache so a long-lived replica cannot grow unbounded. */
    private static readonly RETENTION_CACHE_MAX_ENTRIES = 2000;

    constructor(
        private readonly chunks: TerminalTranscriptChunkRepository,
        private readonly runs: AgentRunRepository,
        private readonly users: UserRepository,
        // @Optional so an install without the subscriptions module wired
        // still boots; a missing service resolves every plan to the
        // fail-closed fallback rather than crashing the publish path.
        @Optional() private readonly entitlements?: EntitlementsService,
    ) {}

    /**
     * Persist the storable frames of one publish batch. Returns the
     * number of chunks offered to storage (0 when the tier keeps
     * nothing, persistence is disabled, or the batch carried no
     * storable frames).
     *
     * NEVER throws — see the class doc.
     */
    async persistFrames(runId: string, frames: ReadonlyArray<TerminalFrame>): Promise<number> {
        try {
            if (!config.terminal.transcript.isPersistenceEnabled()) {
                return 0;
            }
            const storable = frames.filter(
                (frame): frame is Extract<TerminalFrame, { kind: 'stdout' }> =>
                    frame?.kind === 'stdout' &&
                    Number.isSafeInteger(frame.seq) &&
                    frame.seq >= 0 &&
                    typeof frame.data === 'string',
            );
            if (storable.length === 0) {
                return 0;
            }

            const retentionDays = await this.resolveRetentionDays(runId);
            if (retentionDays === RETENTION_NONE) {
                // Cheapest tier: we do not store what retention would
                // delete on the next sweep anyway.
                return 0;
            }

            const maxChars = config.terminal.transcript.getMaxChunkChars();
            const writes: TerminalTranscriptChunkWrite[] = [];
            const seen = new Set<number>();

            for (const frame of storable) {
                // The relay dedupes on seq too, but a batch can carry a
                // duplicate internally and `orIgnore` only covers rows
                // already committed.
                if (seen.has(frame.seq)) {
                    continue;
                }
                seen.add(frame.seq);

                const decoded = this.decodeFrameData(frame.data);
                if (decoded === null) {
                    continue;
                }
                const { text } = redactTerminalText(decoded.text);
                writes.push({
                    runId,
                    seq: frame.seq,
                    direction: 'out',
                    text: text.length > maxChars ? text.slice(0, maxChars) : text,
                    byteLength: decoded.byteLength,
                });
            }

            if (writes.length === 0) {
                return 0;
            }
            await this.chunks.appendMany(writes);
            return writes.length;
        } catch (error) {
            // Best-effort by contract. Log the shape, never the content.
            this.logger.warn(
                `Terminal transcript persistence failed for run ${runId}: ${(error as Error)?.message ?? 'unknown error'}`,
            );
            return 0;
        }
    }

    /**
     * Replay page for a run, `seq >= fromSeq`, oldest first.
     *
     * Doubly capped: `limit` is clamped to
     * `TERMINAL_TRANSCRIPT_REPLAY_MAX_CHUNKS` and the accumulated text is
     * cut at `TERMINAL_TRANSCRIPT_REPLAY_MAX_CHARS`, so a run that
     * printed a gigabyte can never be replayed into one response.
     * Authorization is the CALLER's job — this service is run-scoped, not
     * user-scoped; the controller owner-scopes before calling.
     */
    async getTranscriptPage(
        runId: string,
        options: { fromSeq?: number; limit?: number } = {},
    ): Promise<TerminalTranscriptPage> {
        const maxChunks = config.terminal.transcript.getReplayMaxChunks();
        const maxChars = config.terminal.transcript.getReplayMaxChars();

        const fromSeq =
            Number.isSafeInteger(options.fromSeq) && (options.fromSeq as number) >= 0
                ? (options.fromSeq as number)
                : 0;
        const requested =
            Number.isSafeInteger(options.limit) && (options.limit as number) > 0
                ? (options.limit as number)
                : maxChunks;
        const limit = Math.min(requested, maxChunks);

        // Fetch one extra row so `hasMore` is exact rather than inferred
        // from a full page.
        const rows = await this.chunks.listByRun(runId, fromSeq, limit + 1);
        const total = await this.chunks.countByRun(runId);

        const chunks: TerminalTranscriptPageChunk[] = [];
        let chars = 0;
        let hasMore = false;

        for (const row of rows) {
            if (chunks.length >= limit) {
                hasMore = true;
                break;
            }
            if (chars + row.text.length > maxChars && chunks.length > 0) {
                hasMore = true;
                break;
            }
            chars += row.text.length;
            chunks.push({
                seq: row.seq,
                direction: row.direction,
                text: row.text,
                createdAt: row.createdAt?.toISOString?.() ?? new Date(0).toISOString(),
            });
        }

        return {
            runId,
            chunks,
            lastSeq: chunks.length > 0 ? chunks[chunks.length - 1].seq : null,
            hasMore,
            total,
        };
    }

    /**
     * Retention sweep — the RPC target of the `terminal-transcript-gc`
     * cron. Scans runs with chunks older than the sweep horizon,
     * resolves each run's plan tier, and prunes past that tier's window:
     *
     *   -1 → skipped (forever)
     *    0 → every chunk for the run is deleted
     *    N → chunks older than N days are deleted
     *
     * Tier is resolved per run, not per plan, so a downgrade shortens an
     * existing session's transcript on the next nightly pass.
     */
    async sweepExpired(now: Date = new Date()): Promise<TerminalTranscriptSweepSummary> {
        const summary: TerminalTranscriptSweepSummary = {
            scannedRuns: 0,
            prunedRuns: 0,
            deletedChunks: 0,
            keptForever: 0,
        };

        const batchSize = config.terminal.transcript.getSweepBatchSize();
        const horizonDays = config.terminal.transcript.getSweepHorizonDays();
        // Candidate scan: anything older than the shortest possible
        // window (1 day) is worth resolving. The horizon only bounds how
        // far back a single pass is willing to look.
        const candidateCutoff = new Date(now.getTime() - this.daysToMs(1));
        const horizonCutoff = new Date(now.getTime() - this.daysToMs(horizonDays));

        const runIds = await this.chunks.findRunIdsWithChunksOlderThan(candidateCutoff, batchSize);
        for (const runId of runIds) {
            summary.scannedRuns += 1;
            let retentionDays: number;
            try {
                retentionDays = await this.resolveRetentionDays(runId);
            } catch {
                // Cannot resolve the tier → leave the data alone. A
                // retention sweep must never delete on a lookup failure.
                continue;
            }

            if (retentionDays === RETENTION_FOREVER) {
                summary.keptForever += 1;
                continue;
            }

            const cutoff =
                retentionDays === RETENTION_NONE
                    ? now
                    : new Date(now.getTime() - this.daysToMs(retentionDays));
            // Never scan back past the horizon.
            const effectiveCutoff = cutoff < horizonCutoff ? horizonCutoff : cutoff;

            const deleted = await this.chunks.deleteOlderThanForRun(runId, effectiveCutoff);
            if (deleted > 0) {
                summary.prunedRuns += 1;
                summary.deletedChunks += deleted;
            }
        }

        if (summary.deletedChunks > 0) {
            this.logger.log(
                `Terminal transcript retention swept ${summary.deletedChunks} chunks across ${summary.prunedRuns} runs`,
            );
        }
        return summary;
    }

    /** Drop the memoized retention windows (tests + plan edits). */
    clearRetentionCache(): void {
        this.retentionCache.clear();
    }

    /**
     * Resolve a run's retention window from its owner's plan tier.
     * TTL-cached per run.
     */
    async resolveRetentionDays(runId: string): Promise<number> {
        const now = Date.now();
        const cached = this.retentionCache.get(runId);
        if (cached && cached.expiresAt > now) {
            return cached.days;
        }

        const fallback = config.terminal.transcript.getFallbackRetentionDays();
        let days = fallback;

        const run = await this.runs.findById(runId);
        if (run?.userId && this.entitlements) {
            const user = await this.users.findByIdForScheduledRun(run.userId);
            const planCode = (user?.defaultPlan?.code as string) || '';
            if (planCode) {
                const resolved = await this.entitlements.getNumber(
                    planCode,
                    ENTITLEMENT_KEYS.TERMINAL_TRANSCRIPT_RETENTION_DAYS,
                    fallback,
                );
                days =
                    Number.isFinite(resolved) && resolved >= RETENTION_FOREVER
                        ? resolved
                        : fallback;
            }
        }

        this.rememberRetention(runId, days, now);
        return days;
    }

    private rememberRetention(runId: string, days: number, now: number): void {
        if (this.retentionCache.size >= TerminalTranscriptService.RETENTION_CACHE_MAX_ENTRIES) {
            // Cheap bound: drop the oldest inserted key. Map preserves
            // insertion order, so the first key is the coldest.
            const oldest = this.retentionCache.keys().next();
            if (!oldest.done) {
                this.retentionCache.delete(oldest.value);
            }
        }
        this.retentionCache.set(runId, {
            days,
            expiresAt: now + config.terminal.transcript.getRetentionCacheTtlMs(),
        });
    }

    /**
     * Frames carry base64 PTY bytes. Decode to UTF-8 so the transcript is
     * searchable and redactable; keep the decoded byte length for
     * accounting. Returns null on anything that does not decode.
     */
    private decodeFrameData(data: string): { text: string; byteLength: number } | null {
        try {
            const buffer = Buffer.from(data, 'base64');
            if (buffer.length === 0) {
                return null;
            }
            return { text: buffer.toString('utf-8'), byteLength: buffer.length };
        } catch {
            return null;
        }
    }

    private daysToMs(days: number): number {
        return days * 24 * 60 * 60 * 1000;
    }
}
