/**
 * EW-643 Phase 3 slice 2 — payload contract for the `kb-transcribe`
 * Trigger.dev task.
 *
 * Triggered either:
 *   1. directly from `KnowledgeBaseService` after upload, when the
 *      operator has `KB_MEDIA_NORMALIZE=false` (no normalize stage), or
 *   2. from `kb-normalize-{video,audio}` as a follow-up enqueue once
 *      ffmpeg has produced the normalized object.
 *
 * The task body resolves the AI-provider plugin via
 * `AiFacadeService.transcribe()` (selection chain documented on
 * `IAiProviderPlugin.transcribe`), streams the bytes through, and
 * materializes the returned text as the body of a new
 * `WorkKnowledgeDocument` (class `research` by default, configurable via
 * `Work.kbConfig.transcription.targetClass`).
 *
 * Idempotent: re-running the same payload looks up the upload row, and
 * if a child `WorkKnowledgeDocument` with `metadata.transcribedFromUploadId
 * === uploadId` already exists, the task is a no-op completion.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §14.3 + §14.4
 * (transcription + AI provider selection) + acceptance A28/A29.
 */
export interface KbTranscribePayload {
    readonly workId: string;
    /** UUID of the `work_knowledge_uploads` row to transcribe. */
    readonly uploadId: string;
    /**
     * Storage key pointing at the bytes the AI provider receives.
     * Differs from the upload row's `storagePath` when a normalize
     * stage produced a derivative (the derivative is what we send to
     * Whisper, not the original 1 GB camera dump).
     */
    readonly sourceStoragePath: string;
    /**
     * Reported MIME type of `sourceStoragePath`. Drives the
     * `TranscriptionOptions.filename` extension hint so OpenAI's
     * Whisper endpoint can correctly identify the codec.
     */
    readonly sourceMimeType: string;
    /**
     * Optional BCP-47 language hint. Operator-pinned via
     * `Work.kbConfig.transcription.language`. Whisper auto-detects when
     * absent, but on noisy audio a hint dramatically improves WER.
     */
    readonly language?: string;
}
