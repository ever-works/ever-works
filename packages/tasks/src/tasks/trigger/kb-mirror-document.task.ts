import { logger, task } from '@trigger.dev/sdk';
import { KbMirrorDocumentPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseGitMirrorService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-641 Phase 1B/a — async KB sync task.
 *
 * Picks up one KB document mutation (create / update / delete) and
 * writes the corresponding sidecar `.yml` + body `.md` (or removes them)
 * to the Work's Git data repository under `.content/kb/<class>/...`.
 *
 * Idempotent — running the same payload twice is a no-op commit (the
 * file content matches what's already on disk, status is clean,
 * `KnowledgeBaseGitMirrorService` skips the commit + push).
 *
 * Failures bubble so Trigger.dev's retry/backoff schedule reruns the
 * task automatically. The DB row remains the source of truth in the
 * interim; `lastCommitSha` stays stale until a successful run.
 */
export const kbMirrorDocumentTask = task<'kb-mirror-document', KbMirrorDocumentPayload>({
    id: 'kb-mirror-document',
    maxDuration: 600, // 10 minutes — large repos with hundreds of docs still finish well under
    run: async (payload) => {
        return withWorkerContext('KbMirrorDocument', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();

            // EW-742 P3.2 T22 — see kb-embed-document.task.ts for the
            // full pattern rationale. Idempotent mirror task: a drained
            // skip-and-ack is safe — the next enqueue (or the
            // reconciliation job per spec §17.7) picks up the latest
            // doc state against fresh credentials.
            const binding = await appContext
                .get(TenantRuntimeBindingResolverService)
                .resolveForWork(payload, payload.workId);
            if (binding.status === 'drained') {
                logger.warn('kb-mirror-document: credentials drained, skipping run', {
                    workId: payload.workId,
                    documentId: payload.documentId,
                    operation: payload.operation,
                    providerId: binding.providerId,
                    credentialVersion: binding.credentialVersion,
                    tenantId: binding.tenantId,
                });
                return {
                    status: 'skipped' as const,
                    reason: 'credentials-drained' as const,
                    workId: payload.workId,
                    documentId: payload.documentId,
                };
            }

            const mirror = appContext.get(KnowledgeBaseGitMirrorService);

            if (payload.operation === 'delete') {
                await mirror.removeDocument(payload.workId, {
                    documentId: payload.documentId,
                    path: payload.path,
                    class: payload.class,
                });
            } else {
                await mirror.materializeDocument(payload.workId, payload.documentId);
            }

            return {
                status: 'completed',
                operation: payload.operation,
                workId: payload.workId,
                documentId: payload.documentId,
            };
        });
    },
});
