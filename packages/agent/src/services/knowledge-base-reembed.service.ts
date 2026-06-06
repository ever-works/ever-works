import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AiFacadeService } from '../facades/ai.facade';
import { EmbeddingModeResolver, VectorStoreFacadeService } from '../facades/vector-store.facade';
import { WorkKnowledgeChunkCoordinateRepository } from '../database/repositories/work-knowledge-chunk-coordinate.repository';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { chunkMarkdown } from './kb-chunker';
import type { KbReembedWorkPayload } from '../tasks/kb-reembed-work.types';

/**
 * EW-642 D7 — service backing the `kb-reembed-work` Trigger.dev task.
 *
 * Re-embeds every `(workId, documentId)` coordinate row currently
 * pinned to an embedding model OTHER than `payload.newModel`, against
 * the resolved vector-store plugin for the Work. Lives in the agent
 * package (not `tasks/`) because the same pipeline is exercised by
 * tests, by the CLI re-embed command (future slice), and by the
 * settings-change hook on the pgvector plugin (TODO marker left in
 * place).
 *
 * Pipeline per coordinate row:
 *
 *   1. Refetch the KB document body via `WorkKnowledgeDocumentRepository`.
 *   2. Chunk it with the same `chunkMarkdown(maxTokens=512, overlap=64)`
 *      settings the embed task uses — staying in sync matters because
 *      retrieval citations would otherwise produce off-by-one offsets
 *      between freshly-embedded and re-embedded docs.
 *   3. Either:
 *      a. Resolve the embedding mode via `EmbeddingModeResolver` and
 *         when it returns `'plugin'` — defer embedding to the
 *         vector-store plugin by passing `embedding: null` on each
 *         chunk; the plugin's `upsertChunks` computes vectors
 *         server-side (Weaviate text2vec, Pinecone with managed
 *         embedding, …).
 *      b. Otherwise embed via `AiFacadeService.embed`
 *         (caller-side embedding lane — the legacy path).
 *   4. `vectorStoreFacade.upsertChunks(...)` REPLACES the old chunks
 *      atomically (RFC §4 invariant 2 — by `(workId, documentId,
 *      chunkIndex)`).
 *   5. Update the coordinate row with the new model / dims / chunk
 *      count / `last_embedded_at`.
 *
 * Idempotency: a coordinate row already on `payload.newModel` is
 * skipped (no re-fetch, no re-embed, no upsert). This makes a retry
 * after partial progress cheap — Trigger.dev's retry replays the
 * payload and only the still-stale rows do work.
 *
 * Activity-log lifecycle (best-effort — log failures are warned
 * and swallowed so the sweep itself never fails on activity-log
 * unavailability):
 *
 *   - `KB_REEMBED_STARTED`   — fired once at the top with
 *                              `{ count, fromModel, toModel }`.
 *   - `KB_REEMBED_COMPLETED` — fired once on the happy path with
 *                              `{ durationMs, chunksReembedded,
 *                              documentsReembedded }`.
 *   - `KB_REEMBED_FAILED`    — fired before the error is rethrown
 *                              with `{ error, fromModel, toModel,
 *                              processedDocuments }` so the
 *                              workbench banner can surface progress.
 */

export interface KbReembedResult {
    readonly workId: string;
    readonly documentsReembedded: number;
    readonly documentsSkipped: number;
    readonly chunksReembedded: number;
    readonly fromModel: string;
    readonly toModel: string;
    readonly durationMs: number;
}

const REEMBED_SYSTEM_USER_ID = 'kb-reembed-system';

@Injectable()
export class KnowledgeBaseReembedService {
    private readonly logger = new Logger(KnowledgeBaseReembedService.name);
    private readonly embeddingModeResolver = new EmbeddingModeResolver();

    constructor(
        private readonly coordinates: WorkKnowledgeChunkCoordinateRepository,
        private readonly documents: WorkKnowledgeDocumentRepository,
        private readonly vectorStoreFacade: VectorStoreFacadeService,
        private readonly aiFacade: AiFacadeService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async reembedWork(payload: KbReembedWorkPayload): Promise<KbReembedResult> {
        const startedAt = Date.now();
        let processedDocuments = 0;
        let chunksReembedded = 0;
        let documentsSkipped = 0;

        try {
            // 1. Resolve the vector-store plugin for the Work. The
            // SYSTEM-op user-id sentinel mirrors the row 29b2 embed
            // task — there is no requesting user for a background
            // re-embed sweep.
            const plugin = await this.vectorStoreFacade.select({
                workId: payload.workId,
                userId: REEMBED_SYSTEM_USER_ID,
            });

            // 2. List every coordinate row for the Work, then drop the
            // already-on-newModel rows for idempotency. We deliberately
            // filter by `!== newModel` rather than `=== previousModel`
            // so a partially-migrated Work still finishes the
            // migration in one run (previousModel is a logging hint,
            // not a query predicate).
            const allCoordinates = await this.coordinates.listByWork(payload.workId);
            const staleCoordinates = allCoordinates.filter(
                (row) => row.embeddingModel !== payload.newModel,
            );
            documentsSkipped = allCoordinates.length - staleCoordinates.length;

            await this.recordActivity({
                actionType: ActivityActionType.KB_REEMBED_STARTED,
                action: 'kb_reembed_started',
                status: ActivityStatus.IN_PROGRESS,
                workId: payload.workId,
                summary:
                    `Re-embedding ${staleCoordinates.length} document(s) for work ` +
                    `${payload.workId} (${payload.previousModel} → ${payload.newModel})`,
                details: {
                    count: staleCoordinates.length,
                    fromModel: payload.previousModel,
                    toModel: payload.newModel,
                    skipped: documentsSkipped,
                },
            });

            // 3. Resolve embedding mode once per Work — the mode
            // depends only on the resolved plugin's static
            // capabilities + work/org/env settings, none of which
            // change mid-sweep.
            const embeddingMode = this.embeddingModeResolver.resolve({
                workId: payload.workId,
                resolvedVectorStorePlugin: plugin,
            });

            for (const coord of staleCoordinates) {
                const doc = await this.documents.findById(payload.workId, coord.documentId);
                if (!doc) {
                    // Race with delete — the coordinate row points at a
                    // doc that's gone. Drop the coordinate too so we
                    // don't keep re-discovering this orphan on every
                    // sweep.
                    this.logger.warn(
                        `kb-reembed-work: coordinate ${coord.documentId} has no live document; dropping`,
                    );
                    await this.coordinates.deleteByDocument(payload.workId, coord.documentId);
                    continue;
                }

                const body = (doc.metadata as Record<string, unknown> | null)?.body as
                    | string
                    | undefined;
                const chunks = chunkMarkdown(body ?? '', { maxTokens: 512, overlap: 64 });

                if (chunks.length === 0) {
                    // Whitespace-only body — replace with zero chunks so
                    // the prior set is wiped. Update the coordinate to
                    // the new model so the next sweep doesn't re-touch
                    // this row.
                    await this.vectorStoreFacade.upsertChunks(
                        {
                            workId: payload.workId,
                            documentId: coord.documentId,
                            chunks: [],
                        },
                        { workId: payload.workId, userId: REEMBED_SYSTEM_USER_ID },
                    );
                    await this.coordinates.upsert({
                        workId: payload.workId,
                        documentId: coord.documentId,
                        vectorStoreId: plugin.id,
                        chunkCount: 0,
                        embeddingModel: payload.newModel,
                        embeddingDims: payload.newDims,
                    });
                    processedDocuments += 1;
                    continue;
                }

                // 4. Either embed caller-side (platform mode) or hand
                // the plugin null vectors (plugin mode).
                let embeddings: ReadonlyArray<readonly number[]> | null = null;
                if (embeddingMode === 'platform') {
                    const response = await this.aiFacade.embed(
                        { input: chunks.map((c) => c.content) },
                        { workId: payload.workId, userId: REEMBED_SYSTEM_USER_ID },
                    );
                    if (response.embeddings.length !== chunks.length) {
                        throw new Error(
                            `kb-reembed-work: embedder returned ${response.embeddings.length} ` +
                                `vectors for ${chunks.length} chunks (workId=${payload.workId}, ` +
                                `documentId=${coord.documentId}, model=${response.model})`,
                        );
                    }
                    embeddings = response.embeddings;
                }

                // 5. Upsert via the facade — replaces the old chunks
                // atomically per RFC §4 invariant 2.
                const upsertChunks = chunks.map((c, i) => ({
                    id: randomUUID(),
                    workId: payload.workId,
                    documentId: coord.documentId,
                    chunkIndex: c.index,
                    content: c.content,
                    tokenCount: Math.ceil(c.content.length / 4),
                    embedding: embeddings ? [...embeddings[i]] : null,
                    metadata: {
                        ...(c.headingPath ? { headingPath: c.headingPath } : {}),
                        charRange: { start: c.charStart, end: c.charEnd },
                    },
                }));

                await this.vectorStoreFacade.upsertChunks(
                    {
                        workId: payload.workId,
                        documentId: coord.documentId,
                        chunks: upsertChunks,
                    },
                    { workId: payload.workId, userId: REEMBED_SYSTEM_USER_ID },
                );

                await this.coordinates.upsert({
                    workId: payload.workId,
                    documentId: coord.documentId,
                    vectorStoreId: plugin.id,
                    chunkCount: chunks.length,
                    embeddingModel: payload.newModel,
                    embeddingDims: payload.newDims,
                });

                processedDocuments += 1;
                chunksReembedded += chunks.length;
            }

            const durationMs = Date.now() - startedAt;

            await this.recordActivity({
                actionType: ActivityActionType.KB_REEMBED_COMPLETED,
                action: 'kb_reembed_completed',
                status: ActivityStatus.COMPLETED,
                workId: payload.workId,
                summary:
                    `Re-embedded ${processedDocuments} document(s), ${chunksReembedded} ` +
                    `chunk(s) for work ${payload.workId} (${payload.previousModel} → ` +
                    `${payload.newModel})`,
                details: {
                    durationMs,
                    chunksReembedded,
                    documentsReembedded: processedDocuments,
                    documentsSkipped,
                    fromModel: payload.previousModel,
                    toModel: payload.newModel,
                },
            });

            return {
                workId: payload.workId,
                documentsReembedded: processedDocuments,
                documentsSkipped,
                chunksReembedded,
                fromModel: payload.previousModel,
                toModel: payload.newModel,
                durationMs,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.recordActivity({
                actionType: ActivityActionType.KB_REEMBED_FAILED,
                action: 'kb_reembed_failed',
                status: ActivityStatus.FAILED,
                workId: payload.workId,
                summary:
                    `Re-embed failed for work ${payload.workId} ` +
                    `(${payload.previousModel} → ${payload.newModel}): ${message}`,
                details: {
                    error: message,
                    fromModel: payload.previousModel,
                    toModel: payload.newModel,
                    processedDocuments,
                    chunksReembedded,
                },
            });
            throw error;
        }
    }

    /**
     * Catch-and-warn so an activity-log fault never takes down the
     * re-embed pipeline (parity with
     * `KnowledgeBaseTranscribeService.recordTranscribedActivity`).
     */
    private async recordActivity(entry: {
        actionType: ActivityActionType;
        action: string;
        status: ActivityStatus;
        workId: string;
        summary: string;
        details: Record<string, unknown>;
    }): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: REEMBED_SYSTEM_USER_ID,
                workId: entry.workId,
                actionType: entry.actionType,
                action: entry.action,
                status: entry.status,
                summary: entry.summary,
                details: entry.details,
            });
        } catch (err) {
            this.logger.warn(
                `kb-reembed-work: failed to record ${entry.action} for work ${entry.workId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }
}
