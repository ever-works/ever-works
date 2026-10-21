import { tasks } from '@trigger.dev/sdk';

import { withAppClusterIoIsolation } from '../../trigger/app-cluster-io-isolation';

/**
 * Trigger.dev loads `init.ts` (at the root of a `dirs` entry) before every task it executes, so a
 * global middleware registered here wraps every run in this project.
 *
 * App Works follow-up (e), 2026-10-21: the managed cluster credential is visible only to runs on
 * the dedicated `app-cluster-io` queue — see `app-cluster-io-isolation.ts`. Kept import-light on
 * purpose: the deploy indexer loads this file inside its fixed budget.
 */
tasks.middleware('app-cluster-io-env-isolation', async ({ ctx, task, next }) => {
    await withAppClusterIoIsolation({ queueName: ctx?.queue?.name, taskId: task }, next);
});
