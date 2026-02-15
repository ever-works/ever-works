import { task } from '@trigger.dev/sdk';
import { DirectoryImportPayload } from '@ever-works/agent/tasks';
import { normalizeGeneratorError } from '@ever-works/agent/services';
import { TriggerImportOrchestrator } from '../../trigger/worker/orchestrators/trigger-import.orchestrator';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { createTaskContext } from '../../trigger/worker/utils/task-context.utils';

export const directoryImportTask = task({
    id: 'directory-import',
    maxDuration: 3600 * 2, // 2 hours
    onFailure: async ({ payload, error }) => {
        if (!payload) {
            return;
        }

        try {
            await withWorkerContext('DirectoryImport:Failure', async (appContext) => {
                const { orchestrator, directory } = await createTaskContext(
                    appContext,
                    payload,
                    TriggerImportOrchestrator,
                );

                const errorMessage = normalizeGeneratorError(error);

                await orchestrator.handleFailure({
                    directory,
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

        await withWorkerContext('DirectoryImport:Cancel', async (appContext) => {
            const { orchestrator, directory } = await createTaskContext(
                appContext,
                payload,
                TriggerImportOrchestrator,
            );

            await orchestrator.handleCancellation({
                directory,
                historyId: payload.historyId,
                historyStartedAt: payload.historyStartedAt,
            });
        });
    },
    run: async (payload: DirectoryImportPayload) => {
        return withWorkerContext('DirectoryImport', async (appContext) => {
            const { orchestrator, directory, user, gitToken } = await createTaskContext(
                appContext,
                payload,
                TriggerImportOrchestrator,
            );

            await orchestrator.run({
                directory,
                user,
                payload,
                gitToken,
            });

            return {
                status: 'completed',
                directoryId: payload.directoryId,
            };
        });
    },
});
