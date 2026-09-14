import { Injectable, Logger } from '@nestjs/common';
import {
    MEMORY_FACT_FORGET_RETENTION_DAYS,
    MEMORY_FACT_SWEEP_BATCH_MAX,
} from '@ever-works/contracts';
import { MemoryFactRepository } from '../database/repositories/memory-fact.repository';
import { MemoryFactEmbedService } from './memory-fact-embed.service';
import { MemoryFactVectorIndexService } from './memory-fact-vector-index.service';

/** What one sweep pass did. Logged by the cron task; returned for tests. */
export interface MemoryFactSweepSummary {
    /** Forgotten facts past retention, removed from the table (and their vectors). */
    purged: number;
    /** Live facts that had never been embedded and now are. */
    embedded: number;
    /** Live facts re-embedded because the model, dimensions or store changed. */
    reembedded: number;
    /** Why embedding stopped early, when it did (no provider, no store, …). */
    embedStoppedReason: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bound on purge batches per pass, so one pass cannot run unbounded. */
const PURGE_BATCHES_MAX = 20;

/**
 * AW-07 — the nightly memory-fact sweep (`memory-fact-gc`, cron `13 4 * * *`).
 *
 * Three jobs in one pass, in this order:
 *
 *  1. **Purge** facts forgotten more than
 *     {@link MEMORY_FACT_FORGET_RETENTION_DAYS} days ago. The vector is
 *     removed first (best-effort — a store that is gone cannot hold the
 *     vector hostage), then the row. This is the only place a fact is ever
 *     deleted.
 *  2. **Backfill** live facts that were never embedded — saved while no job
 *     runtime, AI provider or vector store was available, or edited since.
 *     This is how "facts saved while embeddings are unavailable are embedded
 *     automatically once a provider appears" holds.
 *  3. **Re-embed** live facts whose coordinates have drifted: a different
 *     embedding model or dimension, or a different vector store than the
 *     one facts would be written to today.
 *
 * Steps 2 and 3 share one budget of {@link MEMORY_FACT_SWEEP_BATCH_MAX}
 * facts per pass, and stop at the first "no provider / no store" answer —
 * one clear reason in the log beats five hundred identical failures.
 *
 * Context-file revisions have their own retention rule; pruning them joins
 * this pass once that table exists.
 */
@Injectable()
export class MemoryFactSweepService {
    private readonly logger = new Logger(MemoryFactSweepService.name);

    constructor(
        private readonly facts: MemoryFactRepository,
        private readonly embedder: MemoryFactEmbedService,
        private readonly vectors: MemoryFactVectorIndexService,
    ) {}

    async sweep(now: Date = new Date()): Promise<MemoryFactSweepSummary> {
        const purged = await this.purgeExpired(now);

        let budget = MEMORY_FACT_SWEEP_BATCH_MAX;
        let embedded = 0;
        let reembedded = 0;
        let embedStoppedReason: string | null = null;
        let current: {
            embeddingModel: string;
            embeddingDims: number;
            vectorStoreId: string;
        } | null = null;

        const backlog = await this.facts.dueForEmbed(budget);
        for (const fact of backlog) {
            const outcome = await this.embedder.embedLoaded(fact);
            budget--;
            if (outcome.status === 'embedded') {
                embedded++;
                current = {
                    embeddingModel: outcome.embeddingModel,
                    embeddingDims: outcome.embeddingDims,
                    vectorStoreId: outcome.vectorStoreId,
                };
            } else if (outcome.status === 'unavailable') {
                embedStoppedReason = outcome.reason;
                break;
            }
        }

        if (!embedStoppedReason && budget > 0) {
            if (!current) {
                const learned = await this.learnCurrentCoordinates();
                if (learned.ok) {
                    current = learned.coordinates;
                } else {
                    embedStoppedReason = learned.reason;
                }
            }
            if (current) {
                const drifted = await this.facts.dueForReembed(current, budget);
                for (const fact of drifted) {
                    const outcome = await this.embedder.embedLoaded(fact, { force: true });
                    if (outcome.status === 'embedded') {
                        reembedded++;
                    } else if (outcome.status === 'unavailable') {
                        embedStoppedReason = outcome.reason;
                        break;
                    }
                }
            }
        }

        const summary = { purged, embedded, reembedded, embedStoppedReason };
        if (purged > 0 || embedded > 0 || reembedded > 0 || embedStoppedReason) {
            this.logger.log(`memory-fact sweep: ${JSON.stringify(summary)}`);
        }
        return summary;
    }

    private async purgeExpired(now: Date): Promise<number> {
        const cutoff = new Date(now.getTime() - MEMORY_FACT_FORGET_RETENTION_DAYS * DAY_MS);
        let purged = 0;
        for (let batch = 0; batch < PURGE_BATCHES_MAX; batch++) {
            const due = await this.facts.dueForPurge(cutoff, MEMORY_FACT_SWEEP_BATCH_MAX);
            if (due.length === 0) break;
            for (const row of due) {
                if (row.vectorStoreId) {
                    await this.vectors.remove(
                        { userId: row.userId, organizationId: row.organizationId },
                        row.id,
                    );
                }
            }
            purged += await this.facts.deleteByIds(due.map((row) => row.id));
            if (due.length < MEMORY_FACT_SWEEP_BATCH_MAX) break;
        }
        return purged;
    }

    /**
     * When the backfill embedded nothing, the current model is unknown
     * without asking the provider. Embed ONE live fact (it will be
     * re-stamped with the current coordinates either way) to learn it —
     * one small embedding a night, instead of never noticing a model change.
     */
    private async learnCurrentCoordinates(): Promise<{
        ok: boolean;
        coordinates?: { embeddingModel: string; embeddingDims: number; vectorStoreId: string };
        reason?: string | null;
    }> {
        const probe = await this.facts.findProbeCandidate();
        if (!probe) return { ok: false, reason: null };
        const outcome = await this.embedder.embedLoaded(probe, { force: true });
        if (outcome.status === 'unavailable') return { ok: false, reason: outcome.reason };
        if (outcome.status !== 'embedded') return { ok: false, reason: null };
        return {
            ok: true,
            coordinates: {
                embeddingModel: outcome.embeddingModel,
                embeddingDims: outcome.embeddingDims,
                vectorStoreId: outcome.vectorStoreId,
            },
        };
    }
}
