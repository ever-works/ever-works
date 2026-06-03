import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AiFacadeService, TranscriptionNotConfiguredError } from '../facades/ai.facade';
import { config } from '../config';
import type { KbTranscribePayload } from '../tasks/kb-transcribe.types';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { KnowledgeBaseService, KB_STORAGE_PLUGIN } from './knowledge-base.service';
import type { IStoragePlugin } from '@ever-works/plugin';
import type { KbDocumentClass } from '@ever-works/contracts';

/**
 * EW-643 Phase 3 — speech-to-text service backing the `kb-transcribe`
 * Trigger.dev task.
 *
 * Pipeline:
 *
 *   1. Look up `WorkKnowledgeUpload` row.
 *   2. Idempotency check: scan existing `WorkKnowledgeDocument` rows
 *      for one whose `metadata.transcribedFromUploadId === uploadId`.
 *      If found, return its id — the upload row already has its
 *      transcript and re-running the task must not duplicate.
 *   3. Fetch source bytes from storage (the normalized derivative when
 *      normalize ran, else the original).
 *   4. Call `AiFacadeService.transcribe(...)` with the operator-pin
 *      threaded through `facadeOptions.providerOverride`.
 *   5. Materialize a new `WorkKnowledgeDocument` (class
 *      `KB_TRANSCRIPTION_TARGET_CLASS`, default `research`) with
 *      `body = transcript.text` and
 *      `metadata.transcribedFromUploadId = upload.id`.
 *   6. Emit `KB_UPLOAD_TRANSCRIBED` activity event.
 *
 * Failure paths:
 *   - `TranscriptionNotConfiguredError` from the facade — caught by
 *     the task body and surfaced as the upload's `extractionError`
 *     (slice 2c wiring).
 *   - Provider HTTP error — bubbles to Trigger.dev for retry.
 */

export interface KbTranscribeResult {
    readonly documentId: string;
    readonly providerId: string;
    readonly durationSeconds: number;
    readonly tokensUsed: number;
}

@Injectable()
export class KnowledgeBaseTranscribeService {
    private readonly logger = new Logger(KnowledgeBaseTranscribeService.name);

    constructor(
        private readonly uploads: WorkKnowledgeUploadRepository,
        private readonly documents: WorkKnowledgeDocumentRepository,
        private readonly kb: KnowledgeBaseService,
        private readonly aiFacade: AiFacadeService,
        @Inject(KB_STORAGE_PLUGIN) private readonly storage: IStoragePlugin,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async transcribeUpload(payload: KbTranscribePayload): Promise<KbTranscribeResult> {
        const upload = await this.uploads.findById(payload.workId, payload.uploadId);
        if (!upload) {
            throw new Error(
                `kb-transcribe: upload ${payload.uploadId} not found in work ${payload.workId}`,
            );
        }

        // Idempotency — the same payload may be replayed by Trigger.dev's
        // retry schedule, and the worker must not produce a second
        // transcript document. Document IDs are stable; the foreign-key
        // back to the upload row via `metadata.transcribedFromUploadId`
        // gives us a cheap lookup without adding a new column.
        const existing = await this.documents.findByMetadataKey(
            payload.workId,
            'transcribedFromUploadId',
            payload.uploadId,
        );
        if (existing) {
            this.logger.log(
                `kb-transcribe: upload ${payload.uploadId} already transcribed → ${existing.id}`,
            );
            return {
                documentId: existing.id,
                providerId:
                    ((existing.metadata as Record<string, unknown> | null)
                        ?.transcriptionProviderId as string) ?? '',
                durationSeconds:
                    ((existing.metadata as Record<string, unknown> | null)
                        ?.durationSeconds as number) ?? 0,
                tokensUsed: 0,
            };
        }

        const fetched = await this.storage.getObject(payload.sourceStoragePath);
        const filename = friendlyFilename(upload.originalFilename, payload.sourceMimeType);

        const response = await this.aiFacade.transcribe(
            {
                file: fetched.buffer,
                filename,
                language: payload.language ?? config.kb.getTranscriptionLanguage(),
            },
            {
                userId: upload.uploadedById,
                workId: payload.workId,
                providerOverride: config.kb.getTranscriptionProviderId(),
            },
        );

        const targetClass = config.kb.getTranscriptionTargetClass() as KbDocumentClass;
        const docPath = `${targetClass}/transcripts/${upload.id}.md`;
        const title = upload.originalFilename
            ? `Transcript — ${upload.originalFilename}`
            : `Transcript — ${upload.id}`;

        const created = await this.kb.createDocument({
            workId: payload.workId,
            userId: upload.uploadedById,
            path: docPath,
            title,
            description: null,
            class: targetClass,
            body: response.text,
            tags: ['transcript'],
            categories: null,
            language: response.language ?? payload.language ?? null,
            source: 'agent',
            sourceUploadId: upload.id,
            sourceUrl: null,
            generatedByAgentRunId: null,
        });

        // Persist provider + duration on the doc's metadata so the
        // workbench can surface it on the document detail panel and the
        // reconciliation job can verify the transcript belongs to its
        // origin upload.
        await this.documents.updateById(payload.workId, created.id, {
            metadata: {
                body: response.text,
                transcribedFromUploadId: upload.id,
                transcriptionProviderId: response.model,
                durationSeconds: response.durationSeconds,
                detectedLanguage: response.language,
                segmentCount: response.segments?.length ?? 0,
            } as Record<string, unknown>,
        });

        await this.recordTranscribedActivity(
            payload.workId,
            upload.uploadedById,
            upload.id,
            created.id,
            response.model,
            response.durationSeconds,
        );

        return {
            documentId: created.id,
            providerId: response.model,
            durationSeconds: response.durationSeconds ?? 0,
            tokensUsed: 0,
        };
    }

    /**
     * Catch-and-warn so an activity-log fault never takes down the
     * transcription pipeline (parity with `KnowledgeBaseService.recordUploadActivity`).
     */
    private async recordTranscribedActivity(
        workId: string,
        userId: string,
        uploadId: string,
        documentId: string,
        providerId: string,
        durationSeconds?: number,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                workId,
                actionType: ActivityActionType.KB_UPLOAD_TRANSCRIBED,
                action: 'kb_upload_transcribed',
                status: ActivityStatus.COMPLETED,
                summary: `Transcribed upload ${uploadId} → KB doc ${documentId}`,
                details: { uploadId, documentId, providerId, durationSeconds },
            });
        } catch (err) {
            this.logger.warn(
                `kb-transcribe: failed to record activity for upload ${uploadId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }
}

function friendlyFilename(original: string, mimeType: string): string {
    // OpenAI's Whisper endpoint detects format from the filename
    // extension. Pass through the original filename if it has a
    // plausible extension; otherwise synthesize one from the MIME.
    const ext = original.toLowerCase().split('.').pop();
    if (ext && ext.length >= 2 && ext.length <= 5) return original;
    const synthesised =
        mimeType === 'audio/mpeg'
            ? 'audio.mp3'
            : mimeType === 'audio/mp4'
              ? 'audio.m4a'
              : mimeType === 'video/mp4'
                ? 'video.mp4'
                : 'media.bin';
    return synthesised;
}

// Re-export to keep the surface narrow for callers (the task handler in
// `packages/tasks/src/tasks/trigger/kb-transcribe.task.ts`).
export { TranscriptionNotConfiguredError };
