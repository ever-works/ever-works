import { task } from '@trigger.dev/sdk';
import { KbOrgOverlayFanoutPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseGitMirrorService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-641 Phase 2/e row 37 — async fan-out for org-scope KB documents.
 *
 * The enqueue site (row 37b, in `KnowledgeBaseService` create/update/
 * delete for org-scope docs) computes the target `workIds` from the
 * organization → works membership and emits ONE payload. This task
 * iterates the list and calls `materializeOrgDocument` /
 * `removeOrgDocument` per Work — each invocation runs inside its
 * own clone-write-commit cycle, so a single failing Work doesn't
 * block the others.
 *
 * Per-Work errors are caught + logged + tallied; the task continues
 * onto the next Work. Trigger.dev's retry/backoff schedule reruns
 * the entire task on a thrown failure, which would re-do already-
 * materialized Works idempotently (mirror writes are no-op when
 * content matches disk). Today we only re-throw if EVERY Work
 * failed — partial failures surface in the result payload + logs.
 */
export const kbOrgOverlayFanoutTask = task<'kb-org-overlay-fanout', KbOrgOverlayFanoutPayload>({
    id: 'kb-org-overlay-fanout',
    // 10 minutes — every Work clone + commit can take seconds; orgs
    // with many Works finish well under this when each completes in
    // a few seconds.
    maxDuration: 600,
    queue: {
        name: 'kb-org-overlay',
        // Cap to 4 in-flight tasks so a many-org-update burst doesn't
        // contend with the per-Work mirror queue. Same shape as the
        // row 29c kb-embed queue.
        concurrencyLimit: 4,
    },
    run: async (payload) => {
        return withWorkerContext('KbOrgOverlayFanout', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();
            const mirror = appContext.get(KnowledgeBaseGitMirrorService);

            let succeeded = 0;
            const failures: Array<{ workId: string; error: string }> = [];

            for (const workId of payload.workIds) {
                try {
                    if (payload.operation === 'delete') {
                        await mirror.removeOrgDocument(workId, {
                            documentId: payload.documentId,
                            path: payload.path,
                            class: payload.class,
                        });
                    } else {
                        await mirror.materializeOrgDocument(
                            workId,
                            payload.organizationId,
                            payload.documentId,
                        );
                    }
                    succeeded++;
                } catch (err) {
                    const error = err instanceof Error ? err.message : String(err);
                    failures.push({ workId, error });
                }
            }

            // Re-throw if EVERY Work failed so Trigger.dev's retry
            // kicks in. Partial failures stay in the result so the
            // operator can inspect them in the run UI.
            if (failures.length > 0 && succeeded === 0) {
                throw new Error(
                    `kb-org-overlay-fanout: all ${failures.length} Works failed. First error: ${failures[0]?.error}`,
                );
            }

            return {
                status: 'completed' as const,
                operation: payload.operation,
                organizationId: payload.organizationId,
                documentId: payload.documentId,
                workCount: payload.workIds.length,
                succeeded,
                failed: failures.length,
                failures,
            };
        });
    },
});
