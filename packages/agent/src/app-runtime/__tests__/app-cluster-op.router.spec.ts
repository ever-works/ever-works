/**
 * APW-06 T70 — the `app-cluster-op` router (plan §9.10:1572-1573).
 *
 * T70's Done-when is "every op in plan §9.2 has a handler or a named registering task", so the
 * first case here pins §9.2's **fifteen** ids one by one against the classifier: nine route to
 * `AppLifecycleOpsService`, `delete-app-work` to T58, the three `verification-*` to T60, and the two
 * whose owners have not landed (`prepare-namespace` — T69, `dns-reconcile` — T48) are refused
 * `op_handler_unavailable` **with the file that will bring them**, never as `unknown_op`.
 *
 * The rest is the router's own contract: an id outside the fifteen is refused before anything is
 * dialled; R-15's `app_work_deleting` is checked centrally so no handler can forget it; a refusal
 * still writes the `app-op:` entry that `GET app-status` renders; and a handler that throws is a
 * named `handler_failed` rather than a lost run.
 */

import { AppClusterOpRouter } from '../app-cluster-op.router';
import { AppRuntimeDeletionService } from '../app-runtime-deletion.service';
import { AppVerificationTargetService } from '../app-verification-target.service';
import { APP_OP_CACHE_TTL_MS, AppLifecycleOpsService } from '../app-lifecycle-ops.service';
import { WORK_APP_RUNTIME_STATES } from '../../app-launcher/app-launcher.service';

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const OTHER_WORK_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'req-7f3a';

/** A `CACHE_MANAGER` that records what it was asked to store. */
function cacheFake() {
    const entries: Array<{ key: string; value: unknown; ttl: number }> = [];
    return {
        entries,
        set: jest.fn(async (key: string, value: unknown, ttl: number) => {
            entries.push({ key, value, ttl });
        }),
    };
}

/** The state store T17 will bind: one that answers a row, or throws, or is absent. */
function stateFake(row: Record<string, unknown> | null) {
    return { getOrCreate: jest.fn(async () => row) };
}

/** The nine-op service, as the router reaches it: `handle` and nothing else. */
function opsFake(answer: unknown = { op: 'logs', workId: WORK_ID, state: 'done', code: null }) {
    return { handle: jest.fn(async () => answer) } as unknown as AppLifecycleOpsService;
}

describe('AppClusterOpRouter (APW-06 T70)', () => {
    it('routes each of §9.2’s fifteen op ids to its owner', () => {
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        // §9.10's nine — T70's own service.
        for (const op of [
            'status-refresh',
            'logs',
            'pause',
            'resume',
            'remove',
            'cancel-deploy',
            'job-run',
            'cluster-check',
            'ingress-reconcile',
        ]) {
            expect([op, router.route(op)]).toEqual([op, 'lifecycle-ops']);
        }

        expect(router.route('delete-app-work')).toBe('deletion');
        expect(router.route('verification-deploy')).toBe('verification');
        expect(router.route('verification-status')).toBe('verification');
        expect(router.route('verification-destroy')).toBe('verification');

        // The two owners that have not landed are still *known* — the id is real, the handler is not.
        expect(router.route('prepare-namespace')).toBe('unowned');
        expect(router.route('dns-reconcile')).toBe('unowned');
    });

    it('refuses an id outside §9.2 before anything is dialled', async () => {
        const ops = opsFake();
        const router = new AppClusterOpRouter(
            ops,
            {} as never,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        const result = await router.handle({ op: 'explode-everything', workId: WORK_ID });

        expect(result.state).toBe('refused');
        expect(result.code).toBe('unknown_op');
        expect(ops.handle).not.toHaveBeenCalled();
    });

    it('names the file an unowned op waits on instead of calling it unknown', async () => {
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        const prepared = await router.handle({ op: 'prepare-namespace', workId: WORK_ID });
        expect(prepared.code).toBe('op_handler_unavailable');
        expect(prepared.missing).toBe(
            'packages/agent/src/app-runtime/app-runtime-target.resolver.ts',
        );

        const dns = await router.handle({ op: 'dns-reconcile', workId: WORK_ID });
        expect(dns.code).toBe('op_handler_unavailable');
        expect(dns.missing).toBe(
            'packages/agent/src/app-runtime/app-managed-host-root.resolver.ts',
        );
    });

    it('routes `delete-app-work` to T58’s own op handler', async () => {
        const deletion = {
            handleDeleteAppWork: jest.fn(async () => ({
                state: 'done',
                attempts: 1,
                target: 'your-cluster',
                deleted: [],
                kept: [],
                mayRemain: [],
                namespaceDeleted: true,
                completed: true,
            })),
        } as unknown as AppRuntimeDeletionService;
        const router = new AppClusterOpRouter(
            opsFake(),
            deletion,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        const result = await router.handle({
            op: 'delete-app-work',
            workId: WORK_ID,
            requestId: REQUEST_ID,
        });

        expect(deletion.handleDeleteAppWork).toHaveBeenCalledTimes(1);
        expect(result.route).toBe('deletion');
        expect(result.state).toBe('done');
    });

    it('routes the three verification ops to T60’s three handlers', async () => {
        const verification = {
            handleVerificationDeploy: jest.fn(async () => ({ state: 'green' })),
            handleVerificationStatus: jest.fn(async () => ({ state: 'running' })),
            handleVerificationDestroy: jest.fn(async () => ({ state: 'destroyed' })),
        } as unknown as AppVerificationTargetService;
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            verification,
            stateFake(null),
            cacheFake() as never,
        );

        await router.handle({ op: 'verification-deploy', workId: WORK_ID });
        await router.handle({ op: 'verification-status', workId: WORK_ID });
        await router.handle({ op: 'verification-destroy', workId: WORK_ID });

        expect(verification.handleVerificationDeploy).toHaveBeenCalledTimes(1);
        expect(verification.handleVerificationStatus).toHaveBeenCalledTimes(1);
        expect(verification.handleVerificationDestroy).toHaveBeenCalledTimes(1);
    });

    it('lets an explicit registration win over the classifier — §9.10’s extension point', async () => {
        const ops = opsFake();
        const router = new AppClusterOpRouter(
            ops,
            {} as never,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        const registered = jest.fn(async () => ({ state: 'done', code: null }));
        router.register('cluster-check', registered);

        const result = await router.handle({ op: 'cluster-check', workId: WORK_ID });

        expect(router.route('cluster-check')).toBe('registered');
        expect(registered).toHaveBeenCalledTimes(1);
        expect(ops.handle).not.toHaveBeenCalled();
        expect(result.state).toBe('done');
    });

    it('refuses every op while the App Work is being deleted (R-15)', async () => {
        const ops = opsFake();
        const router = new AppClusterOpRouter(
            ops,
            {} as never,
            {} as never,
            stateFake({ deletionRequestedAt: '2026-09-18T09:00:00.000Z' }),
            cacheFake() as never,
        );

        const result = await router.handle({
            op: 'status-refresh',
            workId: WORK_ID,
            requestId: REQUEST_ID,
        });

        expect(result.state).toBe('refused');
        expect(result.code).toBe('app_work_deleting');
        expect(ops.handle).not.toHaveBeenCalled();
    });

    it('refuses when the runtime-state row cannot be read — the truth is unknown', async () => {
        const ops = opsFake();
        const exploding = {
            getOrCreate: jest.fn(async () => {
                throw new Error('the API is unreachable');
            }),
        };
        const router = new AppClusterOpRouter(
            ops,
            {} as never,
            {} as never,
            exploding as never,
            cacheFake() as never,
        );

        const result = await router.handle({ op: 'status-refresh', workId: WORK_ID });

        expect(result.code).toBe('runtime_state_unreadable');
        expect(ops.handle).not.toHaveBeenCalled();
    });

    it('still writes the `app-op:` entry a refusal has to be visible under', async () => {
        const cache = cacheFake();
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            {} as never,
            stateFake({ deletionRequestedAt: '2026-09-18T09:00:00.000Z' }),
            cache as never,
        );

        const result = await router.handle({
            op: 'pause',
            workId: WORK_ID,
            requestId: REQUEST_ID,
        });

        expect(result.cache).toBe('written');
        expect(cache.entries).toEqual([
            {
                key: `app-op:${WORK_ID}:${REQUEST_ID}`,
                value: { op: 'pause', state: 'failed', code: 'app_work_deleting' },
                ttl: APP_OP_CACHE_TTL_MS,
            },
        ]);
        expect(APP_OP_CACHE_TTL_MS).toBe(300_000);
    });

    it('never writes an `app-op:` entry for `logs`, which has its own key (§9.10:1587)', async () => {
        const cache = cacheFake();
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            {} as never,
            stateFake(null),
            cache as never,
        );

        const result = await router.handle({
            op: 'logs',
            workId: WORK_ID,
            requestId: REQUEST_ID,
        });

        expect(result.cache).toBe('skipped');
        expect(cache.entries).toEqual([]);
    });

    it('does not let one Work’s requestId answer for another (§9.10:1587)', async () => {
        const cache = cacheFake();
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            {} as never,
            stateFake({ deletionRequestedAt: '2026-09-18T09:00:00.000Z' }),
            cache as never,
        );

        await router.handle({ op: 'pause', workId: OTHER_WORK_ID, requestId: REQUEST_ID });

        // The workId is part of the key, so a foreign requestId cannot collide with this Work's.
        expect(cache.entries[0].key).toBe(`app-op:${OTHER_WORK_ID}:${REQUEST_ID}`);
        expect(cache.entries.map((entry) => entry.key)).not.toContain(
            `app-op:${WORK_ID}:${REQUEST_ID}`,
        );
    });

    it('reports a throwing handler as `handler_failed` rather than losing the run', async () => {
        const ops = {
            handle: jest.fn(async () => {
                throw new Error('boom');
            }),
        } as unknown as AppLifecycleOpsService;
        const router = new AppClusterOpRouter(
            ops,
            {} as never,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        const result = await router.handle({ op: 'pause', workId: WORK_ID });

        expect(result.state).toBe('failed');
        expect(result.code).toBe('handler_failed');
        expect(result.result).toEqual({ message: 'boom' });
    });

    it('names the member a classified op is missing when its service is not bound', async () => {
        const router = new AppClusterOpRouter(
            undefined,
            undefined,
            undefined,
            stateFake(null),
            cacheFake() as never,
        );

        const result = await router.handle({ op: 'pause', workId: WORK_ID });

        expect(result.code).toBe('op_handler_unavailable');
        expect(result.route).toBe('lifecycle-ops');
        expect(result.missing).toBe('AppLifecycleOpsService.handle');
    });

    it('refuses a payload with no Work', async () => {
        const router = new AppClusterOpRouter(
            opsFake(),
            {} as never,
            {} as never,
            stateFake(null),
            cacheFake() as never,
        );

        const result = await router.handle({ op: 'pause', workId: '' });

        expect(result.code).toBe('invalid_payload');
    });

    it('reads the state row without a store — the guard is reported, not faked', async () => {
        const ops = opsFake();
        const router = new AppClusterOpRouter(
            ops,
            {} as never,
            {} as never,
            undefined,
            cacheFake() as never,
        );

        const result = await router.handle({ op: 'logs', workId: WORK_ID, requestId: REQUEST_ID });

        // T17 has not landed, so the R-15 guard cannot be made; the op that needs no row still runs.
        expect(result.state).toBe('done');
        expect(ops.handle).toHaveBeenCalledTimes(1);
    });
});
