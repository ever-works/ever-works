import { Injectable, Logger } from '@nestjs/common';
import type { KbNormalizeMediaPayload } from '../tasks/kb-normalize-media.types';

/**
 * EW-643 Phase 3 — service interface for ffmpeg-backed media
 * normalization. Implementation skeleton in slice 2; the actual ffmpeg
 * exec + storage round-trip + downstream `kb-transcribe` dispatch lands
 * in **slice 2b** (separate PR — see
 * `docs/specs/features/knowledge-base/phase-3-implementation-notes.md`).
 *
 * Why ship the empty service in slice 2 at all? Because the task
 * scaffolds (`kb-normalize-video.task.ts`, `kb-normalize-audio.task.ts`)
 * reference this class — without the provider, the Trigger.dev worker
 * fails to bootstrap. The skeleton throws a clear
 * `MediaNormalizeNotImplementedError` so a stray dispatch is loud, not
 * silent.
 *
 * The `KB_MEDIA_NORMALIZE` env switch is checked at the **dispatcher**
 * layer (in `KnowledgeBaseService.acceptUpload`, slice 2b), not here —
 * keeping it at the dispatch site means a disabled feature flag avoids
 * touching the Trigger.dev queue at all, instead of round-tripping a
 * payload that the task then ignores.
 */
export interface KbNormalizeResult {
    readonly normalizedStoragePath: string;
    readonly normalizedSha256: string;
    readonly normalizedDurationMs: number;
    /** Run id of the follow-up `kb-transcribe` dispatch, or null when skipped. */
    readonly transcribeRunId: string | null;
}

export class MediaNormalizeNotImplementedError extends Error {
    constructor(stage: 'video' | 'audio') {
        super(
            `KnowledgeBaseMediaNormalizeService.normalize${stage[0].toUpperCase()}${stage.slice(1)} is not implemented yet — ` +
                `the slice 2 PR ships the contract + task scaffold; the ffmpeg exec + storage round-trip + ` +
                `transcribe dispatch lands in slice 2b. See docs/specs/features/knowledge-base/phase-3-implementation-notes.md.`,
        );
        this.name = 'MediaNormalizeNotImplementedError';
    }
}

@Injectable()
export class KnowledgeBaseMediaNormalizeService {
    private readonly logger = new Logger(KnowledgeBaseMediaNormalizeService.name);

    async normalizeVideo(payload: KbNormalizeMediaPayload): Promise<KbNormalizeResult> {
        this.logger.warn(
            `normalizeVideo not implemented (slice 2b); upload=${payload.uploadId} work=${payload.workId}`,
        );
        throw new MediaNormalizeNotImplementedError('video');
    }

    async normalizeAudio(payload: KbNormalizeMediaPayload): Promise<KbNormalizeResult> {
        this.logger.warn(
            `normalizeAudio not implemented (slice 2b); upload=${payload.uploadId} work=${payload.workId}`,
        );
        throw new MediaNormalizeNotImplementedError('audio');
    }
}
