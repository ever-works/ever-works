import { logger, task } from '@trigger.dev/sdk';
import { KbNormalizeMediaPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseMediaNormalizeService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-643 Phase 3 slice 2 — ffmpeg-backed video → MP4 normalization.
 *
 * Inputs an arbitrary video/* upload, transcodes via ffmpeg to a
 * web-friendly H.264 + AAC MP4 (the configurable defaults are picked to
 * play in the workbench `<video>` viewer without a custom codec), writes
 * the result back to storage under
 * `kb-originals/normalized/{originalSha256}.mp4`, and dispatches the
 * follow-up `kb-transcribe` task.
 *
 * Env knobs (read by `KnowledgeBaseMediaNormalizeService`, NOT here, so
 * the task body stays declarative):
 *   - KB_FFMPEG_BIN         — path to the ffmpeg binary. Default `ffmpeg`.
 *   - KB_MEDIA_NORMALIZE    — global toggle. When `false` the upstream
 *                              KB service skips the dispatch entirely;
 *                              the task itself is unconditional once
 *                              fired.
 *   - KB_VIDEO_OUTPUT_CODEC — defaults to `libx264`. Override only when
 *                              an operator's pipeline requires HEVC /
 *                              VP9.
 *
 * Retries: Trigger.dev default exponential backoff. A transient ffmpeg
 * failure (oom, missing decoder for a rare codec) gets two automatic
 * retries before the upload is marked `extractionStatus='failed'`.
 *
 * Concurrency: keyed on `workId` so two large videos uploaded to the
 * same Work serialize on the worker (avoids ffmpeg fighting itself for
 * CPU + temp-disk on a single instance). Different Works run in
 * parallel up to the queue concurrency limit.
 */
export const kbNormalizeVideoTask = task<'kb-normalize-video', KbNormalizeMediaPayload>({
    id: 'kb-normalize-video',
    maxDuration: 1800, // 30 min — enough for a 4K hour-long talk
    run: async (payload) => {
        if (payload.mediaKind !== 'video') {
            throw new Error(
                `kb-normalize-video received non-video payload (mediaKind=${payload.mediaKind})`,
            );
        }
        return withWorkerContext('KbNormalizeVideo', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();
            const svc = appContext.get(KnowledgeBaseMediaNormalizeService);
            logger.info('kb-normalize-video starting', {
                workId: payload.workId,
                uploadId: payload.uploadId,
                originalSha256: payload.originalSha256,
            });
            const result = await svc.normalizeVideo(payload);
            return {
                status: 'completed' as const,
                workId: payload.workId,
                uploadId: payload.uploadId,
                normalizedStoragePath: result.normalizedStoragePath,
                normalizedSha256: result.normalizedSha256,
                normalizedDurationMs: result.normalizedDurationMs,
                transcribeRunId: result.transcribeRunId,
            };
        });
    },
});
