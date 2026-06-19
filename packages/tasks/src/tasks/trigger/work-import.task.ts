import { logger, task } from '@trigger.dev/sdk';
import { WorkImportPayload } from '@ever-works/agent/tasks';
import { normalizeGeneratorError } from '@ever-works/agent/services';
import { TriggerImportOrchestrator } from '../../trigger/worker/orchestrators/trigger-import.orchestrator';
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { createTaskContext } from '../../trigger/worker/utils/task-context.utils';

export const workImportTask = task({
    id: 'work-import',
    maxDuration: 3600 * 2, // 2 hours
    onFailure: async ({ payload, error }) => {
        if (!payload) {
            return;
        }

        try {
            await withWorkerContext('WorkImport:Failure', async (appContext) => {
                const { orchestrator, work } = await createTaskContext(
                    appContext,
                    payload,
                    TriggerImportOrchestrator,
                );

                const errorMessage = normalizeGeneratorError(error);

                await orchestrator.handleFailure({
                    work,
                    historyId: payload.historyId,
                    historyStartedAt: payload.historyStartedAt,
                    errorMessage,
                });
            });
        } catch {
            // Best-effort — if we can't even boot the context, nothing more we can do
        }
    },
    onCancel: async ({ payload }) => {
        if (!payload) {
            return;
        }

        await withWorkerContext('WorkImport:Cancel', async (appContext) => {
            const { orchestrator, work } = await createTaskContext(
                appContext,
                payload,
                TriggerImportOrchestrator,
            );

            await orchestrator.handleCancellation({
                work,
                historyId: payload.historyId,
                historyStartedAt: payload.historyStartedAt,
            });
        });
    },
    run: async (payload: WorkImportPayload) => {
        return withWorkerContext('WorkImport', async (appContext) => {
            // EW-742 P3.2 T22 — see kb-embed-document.task.ts for pattern.
            const binding = await appContext
                .get(TenantRuntimeBindingResolverService)
                .resolveForWork(payload, payload.workId);
            if (binding.status === 'drained') {
                logger.warn('work-import: credentials drained, skipping run', {
                    workId: payload.workId,
                    historyId: payload.historyId,
                    triggerSource: payload.triggerSource,
                    providerId: binding.providerId,
                    credentialVersion: binding.credentialVersion,
                    tenantId: binding.tenantId,
                });
                return {
                    status: 'skipped' as const,
                    reason: 'credentials-drained' as const,
                    workId: payload.workId,
                };
            }

            const { orchestrator, work, user, gitToken } = await createTaskContext(
                appContext,
                payload,
                TriggerImportOrchestrator,
            );

            await orchestrator.run({
                work,
                user,
                payload,
                gitToken,
            });

            return {
                status: 'completed',
                workId: payload.workId,
            };
        });
    },
});
