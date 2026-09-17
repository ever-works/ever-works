import { Injectable, Logger } from '@nestjs/common';
import { MemoryFactRepository } from '../database/repositories/memory-fact.repository';
import type { MemoryFact } from '../entities/memory-fact.entity';
import { MemoryFactVectorIndexService } from './memory-fact-vector-index.service';

/** Outcome of embedding one fact. Never thrown — always returned. */
export type MemoryFactEmbedOutcome =
    | {
          status: 'embedded';
          factId: string;
          vectorStoreId: string;
          embeddingModel: string;
          embeddingDims: number;
      }
    | {
          status: 'skipped';
          factId: string;
          reason: 'missing' | 'forgotten' | 'already-embedded' | 'stale-body';
      }
    | { status: 'unavailable'; factId: string; reason: string };

/**
 * AW-07 — embed one memory fact and record where its vector lives.
 *
 * Called by the `memory-fact-embed` job (over the internal RPC channel,
 * because the AI provider and vector-store plugins are loaded in the API)
 * and by the nightly sweep. The steps:
 *
 *   1. re-read the fact — the job payload is ids only, so an edit that
 *      landed after enqueue is what gets embedded;
 *   2. embed the CURRENT body through the AI facade;
 *   3. write the vector through the vector-store port into the workspace
 *      namespace;
 *   4. record the coordinates on the row, guarded on the body being
 *      unchanged, so an edit racing the embed cannot be stamped with the
 *      old vector's coordinates.
 *
 * Idempotent: an already-embedded fact is skipped unless `force` is set
 * (the sweep forces it when the model or the store has drifted), and an
 * upsert replaces the vector rather than appending one.
 */
@Injectable()
export class MemoryFactEmbedService {
    private readonly logger = new Logger(MemoryFactEmbedService.name);

    constructor(
        private readonly facts: MemoryFactRepository,
        private readonly vectors: MemoryFactVectorIndexService,
    ) {}

    async embedFact(
        factId: string,
        opts: { force?: boolean } = {},
    ): Promise<MemoryFactEmbedOutcome> {
        const fact = await this.facts.findForEmbedding(factId);
        if (!fact) {
            return { status: 'skipped', factId, reason: 'missing' };
        }
        return this.embedLoaded(fact, opts);
    }

    /** Same as {@link embedFact} for a row the caller already loaded. */
    async embedLoaded(
        fact: MemoryFact,
        opts: { force?: boolean } = {},
    ): Promise<MemoryFactEmbedOutcome> {
        if (fact.status === 'forgotten') {
            return { status: 'skipped', factId: fact.id, reason: 'forgotten' };
        }
        if (fact.embeddedAt && !opts.force) {
            return { status: 'skipped', factId: fact.id, reason: 'already-embedded' };
        }

        const embedding = await this.vectors.embed(fact.body, fact.userId);
        if (!embedding.ok) {
            return { status: 'unavailable', factId: fact.id, reason: embedding.detail };
        }

        const key = {
            userId: fact.userId,
            organizationId: fact.organizationId ?? null,
            tenantId: fact.tenantId ?? null,
        };
        const written = await this.vectors.upsert(
            key,
            { id: fact.id, body: fact.body, scope: fact.scope, agentId: fact.agentId ?? null },
            embedding.value,
        );
        if (!written.ok) {
            return { status: 'unavailable', factId: fact.id, reason: written.detail };
        }

        const stamped = await this.facts.markEmbedded(fact.id, fact.body, {
            vectorStoreId: written.value.vectorStoreId,
            embeddingModel: embedding.value.model,
            embeddingDims: embedding.value.dims,
            embeddedAt: new Date(),
        });
        if (!stamped) {
            // The body changed while we embedded. The edit already cleared the
            // coordinates and enqueued its own embed; the vector we just wrote
            // is replaced by that one.
            this.logger.debug(`memory-fact ${fact.id}: body changed during embed; not stamped`);
            return { status: 'skipped', factId: fact.id, reason: 'stale-body' };
        }

        return {
            status: 'embedded',
            factId: fact.id,
            vectorStoreId: written.value.vectorStoreId,
            embeddingModel: embedding.value.model,
            embeddingDims: embedding.value.dims,
        };
    }
}
