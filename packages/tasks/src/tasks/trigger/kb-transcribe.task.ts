import { logger, task } from '@trigger.dev/sdk';
import { KbTranscribePayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseTranscribeService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-643 Phase 3 slice 2 — speech-to-text task.
 *
 * Resolves the AI-provider plugin via `AiFacadeService.transcribe()`
 * (selection chain: operator pin → capability-available → throw).
 * Streams the normalized bytes through, materializes the returned text
 * as the body of a new `WorkKnowledgeDocument` with class `research`
 * (or the value of `Work.kbConfig.transcription.targetClass`).
 *
 * Idempotent: the service checks for an existing
 * `WorkKnowledgeDocument` with `metadata.transcribedFromUploadId ===
 * uploadId` and returns its id on rerun — Trigger.dev replays the
 * payload on retry and we must not duplicate documents.
 *
 * Failure modes that mark the upload `extractionStatus='failed'`:
 *   - `TranscriptionNotConfiguredError` — no AI plugin implements
 *     `transcribe()` AND no operator pin set
 *   - downstream provider HTTP error after the configured retry budget
 *   - input byte size exceeds the resolved provider's per-call cap
 *
 * Concurrency: keyed on `workId` so per-Work transcribe runs serialize
 * but different Works parallelise up to the queue limit.
 */
export const kbTranscribeTask = task<'kb-transcribe', KbTranscribePayload>({
    id: 'kb-transcribe',
    maxDuration: 1800, // 30 min — long enough for chunked audio retries
    run: async (payload) => {
        return withWorkerContext('KbTranscribe', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();

            // EW-742 P3.2 T22 — see kb-embed-document.task.ts for pattern.
            const binding = await appContext
                .get(TenantRuntimeBindingResolverService)
                .resolveForWork(payload, payload.workId);
            if (binding.status === 'drained') {
                logger.warn('kb-transcribe: credentials drained, skipping run', {
                    workId: payload.workId,
                    uploadId: payload.uploadId,
                    providerId: binding.providerId,
                    credentialVersion: binding.credentialVersion,
                    tenantId: binding.tenantId,
                });
                return {
                    status: 'skipped' as const,
                    reason: 'credentials-drained' as const,
                    workId: payload.workId,
                    uploadId: payload.uploadId,
                };
            }

            const svc = appContext.get(KnowledgeBaseTranscribeService);
            logger.info('kb-transcribe starting', {
                workId: payload.workId,
                uploadId: payload.uploadId,
                sourceMimeType: payload.sourceMimeType,
            });
            const result = await svc.transcribeUpload(payload);
            return {
                status: 'completed' as const,
                workId: payload.workId,
                uploadId: payload.uploadId,
                documentId: result.documentId,
                providerId: result.providerId,
                durationSeconds: result.durationSeconds,
                tokensUsed: result.tokensUsed,
            };
        });
    },
});
