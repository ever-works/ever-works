import { Injectable, Logger } from '@nestjs/common';
import type { KbTranscribePayload } from '../tasks/kb-transcribe.types';

/**
 * EW-643 Phase 3 — service interface for the `kb-transcribe` task.
 * Implementation skeleton in slice 2; the actual `AiFacadeService.transcribe`
 * call + `WorkKnowledgeDocument` materialization (idempotency check
 * against `metadata.transcribedFromUploadId`) lands in **slice 2b**.
 *
 * The reason the service exists in slice 2 at all is the same as
 * `KnowledgeBaseMediaNormalizeService`: the Trigger.dev task scaffold
 * references it via DI, so we ship the empty provider now so the
 * worker bootstraps. The skeleton throws a loud `TranscribeNotImplementedError`
 * on any dispatch, surfaced through the upload row's `extractionError`.
 */
export interface KbTranscribeResult {
    /** UUID of the `work_knowledge_documents` row holding the transcript. */
    readonly documentId: string;
    /** AI provider plugin id that produced the transcript (e.g. `openai`). */
    readonly providerId: string;
    /** Audio duration the provider reported back, in seconds. */
    readonly durationSeconds: number;
    /** Token count from the provider's usage envelope, if reported. */
    readonly tokensUsed: number;
}

export class TranscribeNotImplementedError extends Error {
    constructor() {
        super(
            `KnowledgeBaseTranscribeService.transcribeUpload is not implemented yet — ` +
                `the slice 2 PR ships the contract; the AiFacadeService.transcribe call + ` +
                `WorkKnowledgeDocument materialization lands in slice 2b.`,
        );
        this.name = 'TranscribeNotImplementedError';
    }
}

@Injectable()
export class KnowledgeBaseTranscribeService {
    private readonly logger = new Logger(KnowledgeBaseTranscribeService.name);

    async transcribeUpload(payload: KbTranscribePayload): Promise<KbTranscribeResult> {
        this.logger.warn(
            `transcribeUpload not implemented (slice 2b); upload=${payload.uploadId} work=${payload.workId}`,
        );
        throw new TranscribeNotImplementedError();
    }
}
