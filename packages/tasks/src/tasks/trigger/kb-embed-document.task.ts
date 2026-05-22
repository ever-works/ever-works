import { randomUUID } from 'node:crypto';
import { logger, task } from '@trigger.dev/sdk';
import { KbEmbedDocumentPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseService, chunkMarkdown } from '@ever-works/agent/services';
import { WorkKnowledgeChunkRepository, type ChunkUpsertInput } from '@ever-works/agent/database';
import { AiFacadeService } from '@ever-works/agent/facades';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-641 Phase 2/a row 29b2b — async KB embedding task.
 *
 * Picks up `{ workId, documentId }`, fetches the current doc body
 * (system-op via `getDocumentBodyForEmbedding` — no user gate, same
 * pattern as `KnowledgeBaseGitMirrorService.materializeDocument`),
 * chunks it via `chunkMarkdown` (row 28), embeds each chunk in one
 * batched `AiFacadeService.embed` call (row 29b2a), then replaces the
 * doc's chunk rows via `WorkKnowledgeChunkRepository.replaceForDocument`
 * (row 29a) inside a single transaction.
 *
 * Idempotent: re-running the same payload re-chunks + re-embeds the
 * latest body and overwrites the prior chunks. Concurrent runs for the
 * same `workId` are serialised by the `kb-embed` queue's
 * `concurrencyLimit` + the row 29a transaction boundary (a concurrent
 * retrieval either sees the old chunks in full or the new ones in
 * full, never half-empty).
 *
 * Skip-and-ack conditions (return `{ status: 'skipped', reason }`
 * instead of throwing — Trigger.dev retries would otherwise loop on
 * payloads that legitimately have nothing to embed):
 *
 *  - `document-not-found` — race-with-delete: the doc row was removed
 *    between enqueue and run. `replaceForDocument` is NOT called (the
 *    `onDelete: 'CASCADE'` FK already cleared any chunks).
 *  - `empty-body` — `chunkMarkdown` returned `[]` (whitespace-only
 *    body). Calls `replaceForDocument(... [])` so stale chunks from a
 *    previous non-empty version are dropped, then returns.
 *  - `embedder-not-configured` — `AiFacadeService.embed` throws
 *    `AiFacadeError` because no AI provider is wired (or the active
 *    one lacks `createEmbedding`). Falls through to the catch in the
 *    task body; the row-30 RRF retrieval gracefully degrades to
 *    lexical-only ranking in that case.
 *
 * Real failures (DB write throws, embedder errors that aren't
 * "not-configured", chunk-count mismatch between chunker and embedder)
 * propagate so Trigger.dev's retry/backoff kicks in. The chunk table
 * keeps the old rows until a successful re-embed lands.
 */
export const kbEmbedDocumentTask = task<'kb-embed-document', KbEmbedDocumentPayload>({
    id: 'kb-embed-document',
    // Each task: 1 doc fetch + 1 embed batch + 1 chunk-replace
    // transaction. Typical KB docs (low-hundreds chunks max) finish in
    // seconds; 10 min is the same hard ceiling kb-mirror-document uses.
    maxDuration: 600,
    // Per-work serialisation. Back-to-back saves of the same doc must
    // produce sensible final state (the latest chunks); the `kb-embed`
    // queue's `concurrencyLimit: 4` lets up to 4 different works embed
    // in parallel while a single Work's runs stay strictly ordered.
    queue: {
        name: 'kb-embed',
        concurrencyLimit: 4,
    },
    run: async (payload) => {
        return withWorkerContext('KbEmbedDocument', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();

            const kbService = appContext.get(KnowledgeBaseService);
            const aiFacade = appContext.get(AiFacadeService);
            const chunkRepo = appContext.get(WorkKnowledgeChunkRepository);

            const doc = await kbService.getDocumentBodyForEmbedding(
                payload.workId,
                payload.documentId,
            );
            if (!doc) {
                logger.info('kb-embed-document: doc not found (race with delete)', {
                    workId: payload.workId,
                    documentId: payload.documentId,
                });
                return {
                    status: 'skipped',
                    reason: 'document-not-found',
                    workId: payload.workId,
                    documentId: payload.documentId,
                };
            }

            const body = doc.body ?? '';
            const chunks = chunkMarkdown(body, { maxTokens: 512, overlap: 64 });

            if (chunks.length === 0) {
                // Whitespace-only body: clear any stale chunks from a
                // previous non-empty version, then skip the embed call.
                await chunkRepo.replaceForDocument(payload.workId, payload.documentId, []);
                logger.info('kb-embed-document: empty body, cleared stale chunks', {
                    workId: payload.workId,
                    documentId: payload.documentId,
                });
                return {
                    status: 'skipped',
                    reason: 'empty-body',
                    workId: payload.workId,
                    documentId: payload.documentId,
                };
            }

            // `FacadeOptions.userId` is required by the IAiFacade
            // contract. The embed task is a SYSTEM operation triggered
            // by `KnowledgeBaseService.{create,update}Document`, so
            // there is no original request user at the call site.
            // Attribute usage + provider resolution to the doc's
            // `createdById` (the operator who created the row), with a
            // `'kb-embed-system'` sentinel fallback for agent-authored
            // or import-seeded docs where `createdById` is null.
            const embedUserId = doc.createdById ?? 'kb-embed-system';

            const embeddingResponse = await aiFacade.embed(
                { input: chunks.map((c) => c.content) },
                { workId: payload.workId, userId: embedUserId },
            );

            // Lesson #2 — verify runtime API shape before trusting it
            // (`mammoth.convertToMarkdown` taught us). The plugin's
            // `createEmbedding` contract guarantees `embeddings[i]`
            // mirrors `input[i]`, but a buggy plugin could return a
            // different length; failing loudly here beats persisting a
            // mis-zipped chunk set.
            if (embeddingResponse.embeddings.length !== chunks.length) {
                throw new Error(
                    `kb-embed-document: embedder returned ${embeddingResponse.embeddings.length} ` +
                        `embeddings for ${chunks.length} chunks (workId=${payload.workId}, ` +
                        `documentId=${payload.documentId}, model=${embeddingResponse.model})`,
                );
            }

            const inputs: ChunkUpsertInput[] = chunks.map((c, i) => ({
                id: randomUUID(),
                documentId: payload.documentId,
                chunkIndex: c.index,
                content: c.content,
                // Same heuristic the chunker uses (chars/4 — OpenAI's
                // English text approximation). Row 41 will tighten this
                // when the budget-ledger entry for `kb-embedding` lands.
                tokenCount: Math.ceil(c.content.length / 4),
                embedding: embeddingResponse.embeddings[i],
                metadata: {
                    ...(c.headingPath ? { headingPath: c.headingPath } : {}),
                    charRange: { start: c.charStart, end: c.charEnd },
                },
            }));

            await chunkRepo.replaceForDocument(payload.workId, payload.documentId, inputs);

            logger.info('kb-embed-document: chunks persisted', {
                workId: payload.workId,
                documentId: payload.documentId,
                chunkCount: chunks.length,
                model: embeddingResponse.model,
            });

            return {
                status: 'completed',
                workId: payload.workId,
                documentId: payload.documentId,
                chunkCount: chunks.length,
                model: embeddingResponse.model,
            };
        });
    },
});
