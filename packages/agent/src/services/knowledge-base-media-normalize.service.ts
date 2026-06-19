import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config';
import {
    KB_NORMALIZE_MEDIA_DISPATCHER,
    KB_TRANSCRIBE_DISPATCHER,
    type KbNormalizeMediaDispatcher,
    type KbNormalizeMediaPayload,
    type KbTranscribeDispatcher,
    RuntimeBindingStamperService,
} from '../tasks';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { KB_STORAGE_PLUGIN } from './knowledge-base.service';
import type { IStoragePlugin } from '@ever-works/plugin';

/**
 * EW-643 Phase 3 — ffmpeg-backed media normalization service.
 *
 * Pipeline for one media upload (video/* or audio/*):
 *
 *   1. Look up `WorkKnowledgeUpload` row from payload.
 *   2. Fetch original bytes from storage via the configured Storage plugin.
 *   3. Write to a tmp file (ffmpeg's stdin pipe is unreliable on some
 *      container formats — disk-backed is the most-portable shape).
 *   4. Spawn ffmpeg with audio/video-specific codec params.
 *   5. SHA-256 the normalized output.
 *   6. `putObject` to storage under
 *      `kb-originals/normalized/{normalizedSha256}.{ext}`.
 *   7. Update the upload row's `metadata` with `originalSha256` (per spec
 *      §14.3) + `normalizedStoragePath` + `normalizedMimeType`.
 *   8. Dispatch `kb-transcribe` via the injected dispatcher.
 *
 * Throws on ffmpeg failure; Trigger.dev retries the whole task. The
 * upload row stays in `extractionStatus='RUNNING'` until either the
 * downstream transcribe step writes the KB document (then SUCCEEDED)
 * or the retry budget exhausts (then FAILED — the kb-normalize-{video,
 * audio} task catches and updates).
 *
 * Env knobs (read via `config.kb.*`):
 *   - `KB_FFMPEG_BIN` — defaults `ffmpeg`
 *   - `KB_VIDEO_OUTPUT_CODEC` / `KB_VIDEO_OUTPUT_EXT` — `libx264` / `mp4`
 *   - `KB_AUDIO_OUTPUT_CODEC` / `KB_AUDIO_OUTPUT_EXT` — `libmp3lame` / `mp3`
 */

export interface KbNormalizeResult {
    readonly normalizedStoragePath: string;
    readonly normalizedSha256: string;
    readonly normalizedDurationMs: number;
    readonly transcribeRunId: string | null;
}

export class FfmpegFailedError extends Error {
    constructor(
        public readonly stage: 'video' | 'audio',
        public readonly exitCode: number | null,
        stderrTail: string,
    ) {
        super(
            `ffmpeg ${stage} normalization failed (exit ${exitCode ?? 'null'}): ${stderrTail.slice(-400)}`,
        );
        this.name = 'FfmpegFailedError';
    }
}

@Injectable()
export class KnowledgeBaseMediaNormalizeService {
    private readonly logger = new Logger(KnowledgeBaseMediaNormalizeService.name);

    constructor(
        private readonly uploads: WorkKnowledgeUploadRepository,
        // Optional so consumers that import KnowledgeBaseModule but never
        // dispatch a normalize task (e.g. internal-cli's WorkModule import
        // chain) still construct. The API provides KB_STORAGE_PLUGIN via
        // the @Global() KbStorageModule; if storage is missing at the call
        // site we throw a loud runtime error rather than silently no-op.
        @Optional()
        @Inject(KB_STORAGE_PLUGIN)
        private readonly storage?: IStoragePlugin,
        @Optional()
        @Inject(KB_TRANSCRIBE_DISPATCHER)
        private readonly transcribeDispatcher?: KbTranscribeDispatcher,
        // Self-reference accepted but unused — included so the DI
        // signature matches future slice-2c refactors that may dispatch
        // sibling normalize tasks (e.g. multi-resolution video).
        @Optional()
        @Inject(KB_NORMALIZE_MEDIA_DISPATCHER)
        _normalizeDispatcher?: KbNormalizeMediaDispatcher,
        // EW-742 P3.2 T22 — enqueue-site tenant runtime binding capture
        // for the kb-transcribe dispatch. Optional so isolated unit tests
        // and pre-overlay deployments keep constructing — when absent,
        // payload ships null/null and the worker falls back to the
        // instance default (byte-identical pre-T22 path).
        @Optional()
        private readonly runtimeBindingStamper?: RuntimeBindingStamperService,
        // EW-742 P3.2 T22 — used to resolve Work.tenantId for the
        // stamper lookup. Optional same as the stamper.
        @Optional()
        private readonly workRepository?: WorkRepository,
    ) {
        void _normalizeDispatcher;
    }

    /**
     * EW-742 P3.2 T22 — stamp `(providerId, credentialVersion)` for the
     * worker host. Mirrors KnowledgeBaseService.stampForWork (same
     * helper pattern intentionally not extracted to a shared utility:
     * the two services have orthogonal DI graphs and a 12-line private
     * helper is cheaper to read than another `@ever-works/agent/tasks`
     * indirection). Fail-open per FR-5.
     */
    private async stampForWork(
        workId: string,
    ): Promise<{ providerId: string | null; credentialVersion: number | null }> {
        if (!this.runtimeBindingStamper || !this.workRepository) {
            return { providerId: null, credentialVersion: null };
        }
        try {
            const work = await this.workRepository.findById(workId);
            return await this.runtimeBindingStamper.stamp(work?.tenantId ?? null);
        } catch (err) {
            this.logger.debug(
                `kb-normalize-media: stamper lookup failed for work=${workId} ` +
                    `(${(err as Error).message}); falling back to instance default.`,
            );
            return { providerId: null, credentialVersion: null };
        }
    }

    async normalizeVideo(payload: KbNormalizeMediaPayload): Promise<KbNormalizeResult> {
        return this.normalize(payload, 'video');
    }

    async normalizeAudio(payload: KbNormalizeMediaPayload): Promise<KbNormalizeResult> {
        return this.normalize(payload, 'audio');
    }

    private async normalize(
        payload: KbNormalizeMediaPayload,
        stage: 'video' | 'audio',
    ): Promise<KbNormalizeResult> {
        if (!this.storage) {
            throw new Error(
                `kb-normalize-${stage}: KB_STORAGE_PLUGIN is not provided in this DI scope — ` +
                    `wire KbStorageModule (or equivalent) when dispatching media normalize tasks.`,
            );
        }
        const started = Date.now();
        const upload = await this.uploads.findById(payload.workId, payload.uploadId);
        if (!upload) {
            throw new Error(
                `kb-normalize-${stage}: upload ${payload.uploadId} not found in work ${payload.workId}`,
            );
        }

        const original = await this.storage.getObject(upload.storagePath);
        const inputExt =
            guessExtension(upload.originalFilename, original.mimeType) ?? defaultInputExt(stage);
        const outputExt =
            stage === 'video' ? config.kb.getVideoOutputExt() : config.kb.getAudioOutputExt();
        const codec =
            stage === 'video' ? config.kb.getVideoOutputCodec() : config.kb.getAudioOutputCodec();

        const tmp = await mkdtemp(join(tmpdir(), `kb-normalize-${stage}-`));
        const inputPath = join(tmp, `in.${inputExt}`);
        const outputPath = join(tmp, `out.${outputExt}`);
        let normalizedBuffer: Buffer;
        try {
            await writeFile(inputPath, original.buffer);
            await this.runFfmpeg(stage, codec, inputPath, outputPath);
            normalizedBuffer = await readFile(outputPath);
        } finally {
            // Best-effort tmpdir cleanup; never let it surface as a
            // pipeline error (the upload row carries the result either way).
            void rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        }

        const normalizedSha256 = createHash('sha256').update(normalizedBuffer).digest('hex');
        const normalizedMimeType = mimeForExt(outputExt, stage);
        const normalizedKey = `kb-originals/normalized/${normalizedSha256}.${outputExt}`;
        const putResult = await this.storage.putObject({
            buffer: normalizedBuffer,
            filename: normalizedKey,
            mimeType: normalizedMimeType,
            size: normalizedBuffer.byteLength,
            ownerId: upload.uploadedById ?? undefined,
            workId: payload.workId,
        });

        // Persist normalize result on the upload row's metadata so the
        // reconciliation job (slice 5) can detect normalized vs unsourced
        // objects + slice 2c's ingest wiring has a stable path to read
        // for the downstream `kb-transcribe` task.
        const nextMetadata: Record<string, unknown> = {
            ...((upload.metadata as Record<string, unknown> | null | undefined) ?? {}),
            originalSha256: payload.originalSha256 || upload.sha256,
            normalizedStoragePath: putResult.key,
            normalizedSha256,
            normalizedMimeType,
            normalizedAt: new Date().toISOString(),
        };
        await this.uploads.updateById(payload.workId, payload.uploadId, { metadata: nextMetadata });

        // EW-742 P3.2 T22 — stamp the transcribe enqueue with the
        // tenant runtime binding so the worker host can resolveSnapshot.
        const binding = await this.stampForWork(payload.workId);
        const transcribeRunId =
            (await this.transcribeDispatcher?.dispatchKbTranscribe({
                workId: payload.workId,
                uploadId: payload.uploadId,
                sourceStoragePath: putResult.key,
                sourceMimeType: normalizedMimeType,
                language: config.kb.getTranscriptionLanguage(),
                providerId: binding.providerId,
                credentialVersion: binding.credentialVersion,
            })) ?? null;

        return {
            normalizedStoragePath: putResult.key,
            normalizedSha256,
            normalizedDurationMs: Date.now() - started,
            transcribeRunId,
        };
    }

    /**
     * Shared ffmpeg runner. Pins `-y` (overwrite output), `-i` input,
     * codec, and a `-loglevel error` to keep stderr tight. For video,
     * audio passthrough uses AAC; for audio-only output we drop video.
     */
    private async runFfmpeg(
        stage: 'video' | 'audio',
        codec: string,
        input: string,
        output: string,
    ): Promise<void> {
        const bin = config.kb.getFfmpegBin();
        const args =
            stage === 'video'
                ? [
                      '-y',
                      '-loglevel',
                      'error',
                      '-i',
                      input,
                      '-c:v',
                      codec,
                      '-c:a',
                      'aac',
                      '-movflags',
                      '+faststart',
                      output,
                  ]
                : [
                      '-y',
                      '-loglevel',
                      'error',
                      '-i',
                      input,
                      '-vn',
                      '-c:a',
                      codec,
                      '-q:a',
                      '4',
                      output,
                  ];
        this.logger.log(`ffmpeg ${stage}: ${bin} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            const stderrChunks: Buffer[] = [];
            child.stderr.on('data', (chunk: Buffer) => {
                stderrChunks.push(chunk);
                // Cap retained stderr at ~64 KiB so a runaway encoder
                // log doesn't pin worker memory.
                if (stderrChunks.length > 256) stderrChunks.splice(0, stderrChunks.length - 256);
            });
            child.on('error', (err) => reject(err));
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(
                        new FfmpegFailedError(
                            stage,
                            code,
                            Buffer.concat(stderrChunks).toString('utf8'),
                        ),
                    );
                }
            });
        });
    }
}

const VIDEO_EXTENSIONS: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/mpeg': 'mpg',
    'video/x-msvideo': 'avi',
};
const AUDIO_EXTENSIONS: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
};

function guessExtension(filename: string, mimeType: string): string | undefined {
    const fromName = filename.toLowerCase().split('.').pop();
    if (fromName && fromName.length <= 5) return fromName;
    return VIDEO_EXTENSIONS[mimeType] ?? AUDIO_EXTENSIONS[mimeType];
}

function defaultInputExt(stage: 'video' | 'audio'): string {
    return stage === 'video' ? 'mp4' : 'mp3';
}

function mimeForExt(ext: string, stage: 'video' | 'audio'): string {
    if (stage === 'video') {
        return ext === 'mp4' ? 'video/mp4' : `video/${ext}`;
    }
    return ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`;
}
