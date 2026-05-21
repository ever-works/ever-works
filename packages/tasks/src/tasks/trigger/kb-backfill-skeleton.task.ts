import { task } from '@trigger.dev/sdk';
import { KbBackfillSkeletonPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseGitMirrorService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-641 Phase 1B/a — explicit-whitelist backfill that initializes the
 * empty `.content/kb/` skeleton for a list of Works.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §18.2 (backfill).
 *
 * The platform operator passes the `workIds` they want backfilled —
 * typically derived from a SQL query in a one-off admin script. This
 * keeps the task small and review-friendly: no DB scan, no fleet-wide
 * side effects unless the caller explicitly enumerates them. Phase 3
 * will add an admin endpoint + scheduled-discovery wrapper.
 *
 * Idempotent — Works whose skeleton is already in place produce a
 * no-op commit. Per-Work failures are counted but do not abort the
 * remaining backfill.
 */
export const kbBackfillSkeletonTask = task<'kb-backfill-skeleton', KbBackfillSkeletonPayload>({
	id: 'kb-backfill-skeleton',
	maxDuration: 7200, // 2 hours — bulk backfills can take a while
	run: async (payload) => {
		const workIds = payload.workIds ?? [];
		if (workIds.length === 0) {
			return {
				status: 'no-op',
				total: 0,
				succeeded: 0,
				failed: 0,
				failures: [] as Array<{ workId: string; reason: string }>,
			};
		}

		return withWorkerContext('KbBackfillSkeleton', async (appContext) => {
			await appContext.get(TriggerPluginHydratorService).initialize();
			const mirror = appContext.get(KnowledgeBaseGitMirrorService);

			let succeeded = 0;
			let failed = 0;
			const failures: Array<{ workId: string; reason: string }> = [];

			for (const workId of workIds) {
				try {
					await mirror.initializeSkeleton(workId);
					succeeded += 1;
				} catch (error) {
					failed += 1;
					failures.push({ workId, reason: (error as Error).message });
				}
			}

			return {
				status: 'completed',
				total: workIds.length,
				succeeded,
				failed,
				failures: failures.slice(0, 50), // cap to avoid blowing up the run record
			};
		});
	},
});
