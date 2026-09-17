import { Injectable, Logger } from '@nestjs/common';
import {
    MEMORY_FACT_FORGET_RETENTION_DAYS,
    MEMORY_FACT_SWEEP_BATCH_MAX,
} from '@ever-works/contracts';
import {
    MemoryFactRepository,
    type MemoryFactEmbeddingScope,
} from '../database/repositories/memory-fact.repository';
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
 *     one facts would be written to today. The AI provider is chosen per
 *     owner and the vector store per workspace namespace, so drift is
 *     decided per provider-selection scope `(userId, organizationId)`, each
 *     against the coordinates learned in that scope — never one scope's
 *     facts against another's model.
 *
 * Steps 2 and 3 share one budget of {@link MEMORY_FACT_SWEEP_BATCH_MAX}
 * embeddings per pass (a scope's coordinate probe included). The backfill
 * stops at the first "no provider / no store" answer — one clear reason in
 * the log beats five hundred identical failures; the re-embed step skips
 * just the scope that answered it.
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
        // Coordinates learned per provider-selection scope. The AI provider is
        // resolved per owner and the vector store per workspace namespace, so
        // what one scope embeds with says nothing about another's.
        const learned = new Map<string, EmbeddingCoordinates>();

        const backlog = await this.facts.dueForEmbed(budget);
        for (const fact of backlog) {
            const outcome = await this.embedder.embedLoaded(fact);
            budget--;
            if (outcome.status === 'embedded') {
                embedded++;
                learned.set(embeddingScopeKey(fact), {
                    embeddingModel: outcome.embeddingModel,
                    embeddingDims: outcome.embeddingDims,
                    vectorStoreId: outcome.vectorStoreId,
                });
            } else if (outcome.status === 'unavailable') {
                embedStoppedReason = outcome.reason;
                break;
            }
        }

        if (!embedStoppedReason && budget > 0) {
            // Drift is decided inside each scope, against that scope's own
            // coordinates. Scopes whose oldest embed is oldest go first, so a
            // pass that spends its budget early starts elsewhere next night.
            const scopes = await this.facts.embeddedScopes(budget);
            for (const scope of scopes) {
                if (budget <= 0) break;
                const key = embeddingScopeKey(scope);
                let current = learned.get(key) ?? null;
                if (!current) {
                    const probe = await this.learnCurrentCoordinates(scope);
                    if (probe.spent) budget--;
                    if (!probe.ok) {
                        // One scope without a provider or store says nothing
                        // about the next one: note why, and move on.
                        embedStoppedReason = probe.reason ?? embedStoppedReason;
                        continue;
                    }
                    current = probe.coordinates;
                    learned.set(key, current);
                }
                if (budget <= 0) break;
                const drifted = await this.facts.dueForReembed(current, budget, scope);
                for (const fact of drifted) {
                    const outcome = await this.embedder.embedLoaded(fact, { force: true });
                    budget--;
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
     * When the backfill embedded nothing in a scope, that scope's current
     * model is unknown without asking its provider. Embed ONE of its live
     * embedded facts (it is re-stamped with the current coordinates either
     * way, which is why the embedding counts against the pass budget) to
     * learn it — instead of never noticing a model change.
     */
    private async learnCurrentCoordinates(scope: MemoryFactEmbeddingScope): Promise<{
        ok: boolean;
        /** Whether an embedding was requested — it counts against the budget. */
        spent: boolean;
        coordinates?: EmbeddingCoordinates;
        reason?: string | null;
    }> {
        const probe = await this.facts.findProbeCandidate(scope);
        if (!probe) return { ok: false, spent: false, reason: null };
        const outcome = await this.embedder.embedLoaded(probe, { force: true });
        if (outcome.status === 'unavailable') {
            return { ok: false, spent: true, reason: outcome.reason };
        }
        if (outcome.status !== 'embedded') return { ok: false, spent: true, reason: null };
        return {
            ok: true,
            spent: true,
            coordinates: {
                embeddingModel: outcome.embeddingModel,
                embeddingDims: outcome.embeddingDims,
                vectorStoreId: outcome.vectorStoreId,
            },
        };
    }
}

/** Coordinates a scope's facts are embedded with today. */
interface EmbeddingCoordinates {
    embeddingModel: string;
    embeddingDims: number;
    vectorStoreId: string;
}

/** Map key of a fact's (or a scope's) provider-selection scope. */
function embeddingScopeKey(scope: { userId: string; organizationId?: string | null }): string {
    return `${scope.userId}:${scope.organizationId ?? 'personal'}`;
}
