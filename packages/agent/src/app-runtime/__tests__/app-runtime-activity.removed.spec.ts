import { AppRuntimeActivityListener } from '../app-runtime-activity.listener';

/**
 * Lane aw-safety (2026-10-26) — the `app.deploy.removed` row of an App Work deletion is the
 * member's lasting record of what was kept and what may remain, so it carries `kept[]` /
 * `mayRemain[]`, is attributed without reading the Work (which the completion deletes), and is
 * written once more without the FK link when the Work row is already gone.
 */
describe('AppRuntimeActivityListener — app.deploy.removed of an App Work deletion', () => {
    const payload = {
        workId: 'work-1',
        userId: 'owner-1',
        target: 'your-cluster',
        reason: 'app_work_deleted',
        code: 'attempts_exhausted',
        deletedCount: 0,
        kept: [{ kind: 'postgres', name: 'dep-postgres' }],
        mayRemain: [
            { kind: 'Namespace', name: 'ew-hello-1a2b' },
            { kind: 'Component', name: 'web' },
        ],
    };

    it('carries the reason, the counts and the refs as Kind/name, and names what may remain', async () => {
        const rows: Array<Record<string, unknown>> = [];
        const listener = new AppRuntimeActivityListener({
            log: async (row: Record<string, unknown>) => {
                rows.push(row);
                return row;
            },
        } as never);

        await listener.onDeployRemoved(payload);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            userId: 'owner-1',
            workId: 'work-1',
            action: 'app.deploy.removed',
            metadata: {
                reason: 'app_work_deleted',
                code: 'attempts_exhausted',
                deletedCount: '0',
                kept: ['postgres/dep-postgres'],
                mayRemain: ['Namespace/ew-hello-1a2b', 'Component/web'],
            },
        });
        expect(String(rows[0].summary)).toContain('may remain: Namespace/ew-hello-1a2b');
    });

    it('rewrites the row without the Work link when the Work is already gone (the FK race)', async () => {
        const rows: Array<Record<string, unknown>> = [];
        let first = true;
        const listener = new AppRuntimeActivityListener({
            log: async (row: Record<string, unknown>) => {
                if (first) {
                    first = false;
                    throw new Error('insert violates foreign key constraint "FK_activity_work"');
                }
                rows.push(row);
                return row;
            },
        } as never);

        await expect(listener.onDeployRemoved(payload)).resolves.toBeUndefined();

        expect(rows).toHaveLength(1);
        expect(rows[0].workId).toBeUndefined();
        expect(rows[0].metadata).toMatchObject({ workId: 'work-1', reason: 'app_work_deleted' });
    });

    it('keeps the old behaviour for every other removal: one attempt, no rewrite', async () => {
        let calls = 0;
        const listener = new AppRuntimeActivityListener({
            log: async () => {
                calls += 1;
                throw new Error('db down');
            },
        } as never);

        await listener.onDeployRemoved({
            workId: 'work-1',
            userId: 'owner-1',
            reason: 'owner_removed',
        });

        expect(calls).toBe(1);
    });
});
