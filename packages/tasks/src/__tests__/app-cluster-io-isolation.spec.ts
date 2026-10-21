import { describe, expect, it } from 'vitest';

import {
    APP_CLUSTER_IO_ONLY_ENV,
    isAppClusterIoRun,
    restoreAppClusterOnlyEnv,
    stashAppClusterOnlyEnv,
    withAppClusterIoIsolation,
} from '../trigger/app-cluster-io-isolation';

/**
 * App Works follow-up (e), 2026-10-21 — the managed cluster credential exists only for runs on the
 * dedicated `app-cluster-io` queue. A Trigger.dev environment's variables are shared by every task,
 * so without this an agent run (and anything it spawns) could read the managed kubeconfig.
 */

const SECRET = 'apiVersion: v1\nkind: Config\n# sentinel-managed-kubeconfig';

function env(): NodeJS.ProcessEnv {
    return { EVER_WORKS_APPS_MANAGED_KUBECONFIG: SECRET, OTHER: 'kept' };
}

describe('app-cluster-io env isolation', () => {
    it('names the managed kubeconfig as cluster-only', () => {
        expect(APP_CLUSTER_IO_ONLY_ENV).toContain('EVER_WORKS_APPS_MANAGED_KUBECONFIG');
    });

    it('recognises a cluster run by its queue, or by its task id when the queue reads otherwise', () => {
        expect(isAppClusterIoRun('app-cluster-io', 'anything')).toBe(true);
        expect(isAppClusterIoRun('task/app-deploy', 'app-deploy')).toBe(true);
        expect(isAppClusterIoRun(undefined, 'app-dependency-provision')).toBe(true);
        expect(isAppClusterIoRun('task/agent-task-execute', 'agent-task-execute')).toBe(false);
    });

    it('hides the credential from a non-cluster run and restores it afterwards', async () => {
        const vars = env();
        let seen: string | undefined = 'unset';

        await withAppClusterIoIsolation(
            { queueName: 'task/agent-task-execute', taskId: 'agent-task-execute' },
            async () => {
                seen = vars.EVER_WORKS_APPS_MANAGED_KUBECONFIG;
            },
            vars,
        );

        expect(seen).toBeUndefined();
        expect(vars.EVER_WORKS_APPS_MANAGED_KUBECONFIG).toBe(SECRET);
        expect(vars.OTHER).toBe('kept');
    });

    it('restores the credential even when the run throws', async () => {
        const vars = env();

        await expect(
            withAppClusterIoIsolation(
                { queueName: 'task/kb-embed-document', taskId: 'kb-embed-document' },
                async () => {
                    throw new Error('boom');
                },
                vars,
            ),
        ).rejects.toThrow('boom');

        expect(vars.EVER_WORKS_APPS_MANAGED_KUBECONFIG).toBe(SECRET);
    });

    it('leaves a cluster run untouched', async () => {
        const vars = env();
        let seen: string | undefined;

        await withAppClusterIoIsolation(
            { queueName: 'app-cluster-io', taskId: 'app-deploy' },
            async () => {
                seen = vars.EVER_WORKS_APPS_MANAGED_KUBECONFIG;
            },
            vars,
        );

        expect(seen).toBe(SECRET);
    });

    it('never overwrites a value set during the run', () => {
        const vars = env();
        const stashed = stashAppClusterOnlyEnv('other', 'other', vars);
        vars.EVER_WORKS_APPS_MANAGED_KUBECONFIG = 'set-during-run';

        restoreAppClusterOnlyEnv(stashed, vars);

        expect(vars.EVER_WORKS_APPS_MANAGED_KUBECONFIG).toBe('set-during-run');
    });
});
