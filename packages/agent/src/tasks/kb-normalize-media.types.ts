/**
 * EW-643 Phase 3 slice 2 — payload contract for the two ffmpeg-backed
 * normalization tasks (`kb-normalize-video`, `kb-normalize-audio`).
 *
 * Triggered from `KnowledgeBaseService` immediately after a
 * `WorkKnowledgeUpload` row lands for a video/* or audio/* MIME family
 * AND `KB_MEDIA_NORMALIZE` is enabled. The task fetches the original
 * bytes via the configured storage plugin, runs ffmpeg, writes the
 * normalized output back to storage under
 * `kb-originals/normalized/{sha256}.{ext}`, and dispatches the follow-up
 * `kb-transcribe` task.
 *
 * Idempotent: re-running the same payload re-derives the normalized
 * sha256 from the original (ffmpeg is deterministic with the codec
 * params we pin) and skips the write when the storage object already
 * exists. The DB row's `extractionStatus` stays `RUNNING` from upload
 * acceptance until the downstream transcribe step lands.
 *
 * Why a separate task and not inline in the upload route? Two reasons:
 *
 *   1. ffmpeg latency varies wildly with input duration. A 90-minute
 *      podcast upload would block the HTTP request and time out long
 *      before normalization finishes.
 *   2. Transcoding is the kind of work that benefits from Trigger.dev's
 *      retry + backoff schedule. A spurious ffmpeg failure on a
 *      corrupted byte range gets retried instead of marking the upload
 *      permanently failed.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §14.3 (media
 * normalization) + §9.6 (lock semantics — normalize/transcribe must
 * respect `Work.kbConfig.normalize.video|audio`).
 */
export interface KbNormalizeMediaPayload {
    readonly workId: string;
    /** UUID of the `work_knowledge_uploads` row holding the original media. */
    readonly uploadId: string;
    /**
     * MIME family — used as a coarse discriminator inside the task so
     * the two task ids (`kb-normalize-video` / `kb-normalize-audio`)
     * share a single payload contract. The task implementation rejects
     * the call if the family doesn't match its own kind.
     */
    readonly mediaKind: 'video' | 'audio';
    /**
     * Original SHA-256 of the bytes. Preserved on the upload row's
     * `metadata.originalSha256` per spec §14.3 for traceability and so
     * the reconciliation job (slice 5) can detect normalized vs unsourced
     * objects.
     */
    readonly originalSha256: string;
    /**
     * Reported MIME type of the original (e.g. `video/quicktime`).
     * Drives ffmpeg's `-f` autodetection and the output filename
     * extension fallback when the input has no extension.
     */
    readonly originalMimeType: string;

    /**
     * EW-742 P3.2 T22 — enqueue-site tenant-runtime binding capture.
     * See `KbEmbedDocumentPayload` (the PoC dispatcher) for the full
     * contract; the same null/null fail-open semantics apply.
     */
    readonly providerId?: string | null;
    readonly credentialVersion?: number | null;
}
