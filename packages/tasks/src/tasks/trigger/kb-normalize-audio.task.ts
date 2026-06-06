import { logger, task } from '@trigger.dev/sdk';
import { KbNormalizeMediaPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseMediaNormalizeService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-643 Phase 3 slice 2 — ffmpeg-backed audio → MP3 normalization.
 *
 * Inputs an arbitrary audio/* upload, transcodes via ffmpeg to a
 * compact MP3 (libmp3lame, mono, 44.1 kHz, 96 kbps by default — small
 * enough to send to Whisper without splitting; the workbench
 * `<audio>` viewer plays it directly). Writes the result back to
 * storage under `kb-originals/normalized/{originalSha256}.mp3` and
 * dispatches the follow-up `kb-transcribe` task.
 *
 * See the `kb-normalize-video` task header for the env knobs + retry +
 * concurrency rationale (shared).
 */
export const kbNormalizeAudioTask = task<'kb-normalize-audio', KbNormalizeMediaPayload>({
    id: 'kb-normalize-audio',
    maxDuration: 900, // 15 min — enough for a multi-hour podcast
    run: async (payload) => {
        if (payload.mediaKind !== 'audio') {
            throw new Error(
                `kb-normalize-audio received non-audio payload (mediaKind=${payload.mediaKind})`,
            );
        }
        return withWorkerContext('KbNormalizeAudio', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();
            const svc = appContext.get(KnowledgeBaseMediaNormalizeService);
            logger.info('kb-normalize-audio starting', {
                workId: payload.workId,
                uploadId: payload.uploadId,
                originalSha256: payload.originalSha256,
            });
            const result = await svc.normalizeAudio(payload);
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
