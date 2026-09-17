import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { QueryHit } from '@ever-works/plugin';
import { AiFacadeService } from '../facades/ai.facade';
import {
    VectorStoreFacadeService,
    VectorStoreNotConfiguredError,
} from '../facades/vector-store.facade';

/** A text embedded by the workspace's AI provider. */
export interface MemoryFactEmbedding {
    vector: number[];
    model: string;
    dims: number;
}

/** Workspace identity a fact's vector namespace is derived from. */
export interface MemoryFactNamespaceKey {
    userId: string;
    organizationId: string | null;
    tenantId?: string | null;
}

/** One ranked hit from the vector store, mapped back to a fact id. */
export interface MemoryFactVectorHit {
    factId: string;
    /** The vector store's `normalizedScore`, `[0, 1]`, higher is better. */
    normalizedScore: number;
}

/** Why a vector operation could not complete. */
export type MemoryFactVectorFailure = 'not-configured' | 'unavailable' | 'failed';

/**
 * Outcome — callers degrade on `ok: false`, never throw.
 *
 * Every member declares every field (the absent ones as optional `undefined`)
 * so property access type-checks in this package, which compiles with
 * `strictNullChecks: false` — a setting under which a boolean discriminant
 * does not narrow a union.
 */
export type MemoryFactVectorResult<T> =
    | { ok: true; value: T; reason?: undefined; detail?: undefined }
    | { ok: false; value?: undefined; reason: MemoryFactVectorFailure; detail: string };

const VECTOR_KIND = 'memory-fact';

/**
 * AW-07 — the ONE place memory facts touch vectors.
 *
 * ## It is an adapter over existing ports, not a vector abstraction
 *
 * Embeddings come from `AiFacadeService.embed()` (whichever AI provider the
 * capability cascade resolves) and vectors go through
 * `VectorStoreFacadeService` — the same selection chain the Knowledge Base
 * uses, so the bundled pgvector store, a registry-installed Qdrant store, or
 * anything else implementing the vector-store capability serves facts with
 * no code here knowing which. No plugin id appears in this file.
 *
 * ## The namespace
 *
 * The capability is keyed by a `workId`, the leftmost filter every backend
 * enforces (row filter, collection, or namespace — the plugin decides).
 * Facts belong to a workspace, not a Work, so each workspace gets a
 * deterministic UUID namespace derived from `(userId, organizationId)`.
 * Every vector read is additionally re-checked against the database with the
 * caller's ownership predicate before a fact is returned, so a backend that
 * ever leaked across namespaces still could not surface another workspace's
 * fact.
 *
 * ## Failure posture
 *
 * Nothing here throws. A missing embedder, a missing or unwired vector
 * store, or a vendor error all come back as `{ ok: false }`, because every
 * caller has a documented degraded path: search falls back to literal
 * matching, and an unembedded fact is picked up by the nightly sweep. A
 * missing vector backend must never make a fact un-saveable or a search
 * un-runnable.
 */
@Injectable()
export class MemoryFactVectorIndexService {
    private readonly logger = new Logger(MemoryFactVectorIndexService.name);

    /** Log a degraded backend once per process, not once per keystroke. */
    private degradedLogged = false;

    constructor(
        @Optional() private readonly aiFacade?: AiFacadeService,
        @Optional() private readonly vectorStoreFacade?: VectorStoreFacadeService,
    ) {}

    /**
     * Deterministic UUID namespace for a workspace's facts.
     *
     * sha256 over a versioned key, formatted as an RFC 4122 version-5-shaped
     * UUID so every backend that validates the `workId` as a UUID (the
     * pgvector row filter does; Qdrant embeds it in a collection name)
     * accepts it.
     */
    namespaceFor(key: MemoryFactNamespaceKey): string {
        const digest = createHash('sha256')
            .update(`memory-facts:v1:${key.userId}:${key.organizationId ?? 'personal'}`)
            .digest('hex');
        const hex = digest.slice(0, 32).split('');
        hex[12] = '5';
        hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
        const s = hex.join('');
        return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
    }

    /** Embed one text. `ok: false` when no provider can embed right now. */
    async embed(
        text: string,
        userId: string,
    ): Promise<MemoryFactVectorResult<MemoryFactEmbedding>> {
        if (!this.aiFacade) {
            return { ok: false, reason: 'not-configured', detail: 'AI facade not wired' };
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return { ok: false, reason: 'failed', detail: 'empty text' };
        }
        try {
            const response = await this.aiFacade.embed({ input: trimmed }, { userId });
            const vector = response.embeddings[0];
            if (!vector || vector.length === 0) {
                return { ok: false, reason: 'failed', detail: 'provider returned no embedding' };
            }
            return {
                ok: true,
                value: { vector: [...vector], model: response.model, dims: vector.length },
            };
        } catch (error) {
            return { ok: false, reason: 'not-configured', detail: messageOf(error) };
        }
    }

    /**
     * Write (replace) one fact's vector. Returns the id of the vector-store
     * plugin that now holds it — recorded on the fact as its coordinate.
     */
    async upsert(
        key: MemoryFactNamespaceKey,
        fact: { id: string; body: string; scope: string; agentId: string | null },
        embedding: MemoryFactEmbedding,
    ): Promise<MemoryFactVectorResult<{ vectorStoreId: string }>> {
        if (!this.vectorStoreFacade) {
            return { ok: false, reason: 'not-configured', detail: 'vector-store facade not wired' };
        }
        const namespace = this.namespaceFor(key);
        try {
            const plugin = await this.vectorStoreFacade.select({
                workId: namespace,
                userId: key.userId,
            });
            await plugin.upsertChunks({
                workId: namespace,
                documentId: fact.id,
                chunks: [
                    {
                        id: fact.id,
                        workId: namespace,
                        documentId: fact.id,
                        chunkIndex: 0,
                        content: fact.body,
                        tokenCount: Math.ceil(fact.body.length / 4),
                        embedding: embedding.vector,
                        metadata: {
                            kind: VECTOR_KIND,
                            scope: fact.scope,
                            agentId: fact.agentId,
                        },
                        tenantId: key.tenantId ?? null,
                        organizationId: key.organizationId,
                    },
                ],
            });
            return { ok: true, value: { vectorStoreId: plugin.id } };
        } catch (error) {
            return this.degrade('upsert', error);
        }
    }

    /** Nearest facts to `embedding` in the workspace namespace, best first. */
    async query(
        key: MemoryFactNamespaceKey,
        embedding: MemoryFactEmbedding,
        topK: number,
    ): Promise<MemoryFactVectorResult<MemoryFactVectorHit[]>> {
        if (!this.vectorStoreFacade) {
            return { ok: false, reason: 'not-configured', detail: 'vector-store facade not wired' };
        }
        if (topK <= 0) {
            return { ok: true, value: [] };
        }
        const namespace = this.namespaceFor(key);
        try {
            const result = await this.vectorStoreFacade.queryChunks(
                { workId: namespace, queryEmbedding: embedding.vector, topK },
                { workId: namespace, userId: key.userId },
            );
            return { ok: true, value: result.hits.map(toHit).filter(isHit) };
        } catch (error) {
            return this.degrade('query', error);
        }
    }

    /** Remove one fact's vector. Best-effort — the purge proceeds either way. */
    async remove(
        key: MemoryFactNamespaceKey,
        factId: string,
    ): Promise<MemoryFactVectorResult<true>> {
        if (!this.vectorStoreFacade) {
            return { ok: false, reason: 'not-configured', detail: 'vector-store facade not wired' };
        }
        const namespace = this.namespaceFor(key);
        try {
            await this.vectorStoreFacade.deleteByDocument(
                { workId: namespace, documentId: factId },
                { workId: namespace, userId: key.userId },
            );
            return { ok: true, value: true };
        } catch (error) {
            return this.degrade('remove', error);
        }
    }

    /**
     * Whether a vector store is selectable and reports itself healthy for
     * this workspace. A cheap probe for the "meaning-based search needs an AI
     * provider" note — it does not spend an embedding.
     */
    async isAvailable(key: MemoryFactNamespaceKey): Promise<boolean> {
        if (!this.aiFacade || !this.vectorStoreFacade) return false;
        const namespace = this.namespaceFor(key);
        try {
            const plugin = await this.vectorStoreFacade.select({
                workId: namespace,
                userId: key.userId,
            });
            return await plugin.isAvailable();
        } catch {
            return false;
        }
    }

    /** The id of the store facts would be written to right now, or null. */
    async currentStoreId(key: MemoryFactNamespaceKey): Promise<string | null> {
        if (!this.vectorStoreFacade) return null;
        try {
            const plugin = await this.vectorStoreFacade.select({
                workId: this.namespaceFor(key),
                userId: key.userId,
            });
            return plugin.id;
        } catch {
            return null;
        }
    }

    private degrade(
        operation: string,
        error: unknown,
    ): { ok: false; value?: undefined; reason: MemoryFactVectorFailure; detail: string } {
        const reason = classify(error);
        const detail = messageOf(error);
        if (reason === 'failed') {
            this.logger.warn(`memory-fact vector ${operation} failed: ${detail}`);
        } else if (!this.degradedLogged) {
            this.degradedLogged = true;
            this.logger.warn(
                `memory-fact vector ${operation}: no usable vector store (${detail}) — facts stay ` +
                    `searchable by exact words until one is configured.`,
            );
        }
        return { ok: false, reason, detail };
    }
}

function toHit(hit: QueryHit): MemoryFactVectorHit | null {
    const factId = hit.chunk?.documentId;
    if (typeof factId !== 'string' || factId.length === 0) return null;
    return { factId, normalizedScore: hit.normalizedScore };
}

function isHit(hit: MemoryFactVectorHit | null): hit is MemoryFactVectorHit {
    return hit !== null;
}

/**
 * Structural classification — survives the agent ↔ plugin package boundary
 * regardless of how the plugin bundle was built (same rule the Knowledge
 * Base follows for `VectorStoreError`).
 */
function classify(error: unknown): MemoryFactVectorFailure {
    if (error instanceof VectorStoreNotConfiguredError) return 'not-configured';
    if (
        error instanceof Error &&
        error.name === 'VectorStoreError' &&
        (error as { code?: string }).code === 'unavailable'
    ) {
        return 'unavailable';
    }
    return 'failed';
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
