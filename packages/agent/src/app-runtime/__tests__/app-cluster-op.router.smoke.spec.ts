/**
 * Lane aw-ops (2026-10-27) — the `smoke` op of the `app-cluster-op` router: `POST :id/app-smoke`
 * queues it, and the router hands it to the same `AppSmokeService.run` the `app-smoke` task calls.
 *
 * Pinned: the op is routed to the smoke service (not to the lifecycle handlers), its outcome is
 * written to `app-op:` so `GET app-status` can render it, a run that did not pass carries
 * `smoke_failed`, a context without the service is a named refusal, and R-15 still refuses it.
 */

import { AppClusterOpRouter } from '../app-cluster-op.router';
import { APP_OP_CACHE_TTL_MS, type AppLifecycleOpsService } from '../app-lifecycle-ops.service';
import type { AppSmokeService } from '../app-smoke.service';

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const DEPLOYMENT_ID = '7d1f3a52-2222-4b3c-8d4e-5f6071829304';
const REQUEST_ID = 'b5e1c7a0-3333-4c4d-9e5f-607182930415';

function cacheFake() {
    const entries: Array<{ key: string; value: unknown; ttl: number }> = [];
    return {
        entries,
        set: jest.fn(async (key: string, value: unknown, ttl: number) => {
            entries.push({ key, value, ttl });
        }),
    };
}

function opsFake() {
    return { handle: jest.fn(async () => ({ state: 'done', code: null })) };
}

function smokeFake(answer: Record<string, unknown>) {
    return { run: jest.fn(async () => answer) };
}

function router(opts: {
    smoke?: ReturnType<typeof smokeFake>;
    row?: Record<string, unknown> | null;
    ops?: ReturnType<typeof opsFake>;
    cache?: ReturnType<typeof cacheFake>;
}) {
    return new AppClusterOpRouter(
        (opts.ops ?? opsFake()) as unknown as AppLifecycleOpsService,
        {} as never,
        {} as never,
        { getOrCreate: jest.fn(async () => opts.row ?? null) } as never,
        (opts.cache ?? cacheFake()) as never,
        opts.smoke as unknown as AppSmokeService,
    );
}

describe('AppClusterOpRouter — the smoke op (lane aw-ops)', () => {
    it('routes `smoke` to AppSmokeService.run, never to the lifecycle handlers', async () => {
        const smoke = smokeFake({ state: 'done', code: null, passed: true });
        const ops = opsFake();
        const cache = cacheFake();
        const r = router({ smoke, ops, cache });

        expect(r.route('smoke')).toBe('smoke');
        const result = await r.handle({
            op: 'smoke',
            workId: WORK_ID,
            requestId: REQUEST_ID,
            userId: 'user-1',
            deploymentId: DEPLOYMENT_ID,
            trigger: 'manual',
        });

        expect(smoke.run).toHaveBeenCalledWith({
            workId: WORK_ID,
            deploymentId: DEPLOYMENT_ID,
            trigger: 'manual',
            userId: 'user-1',
        });
        expect(ops.handle).not.toHaveBeenCalled();
        expect(result).toMatchObject({ state: 'done', route: 'smoke', code: null });
        expect(cache.entries).toEqual([
            {
                key: `app-op:${WORK_ID}:${REQUEST_ID}`,
                value: { op: 'smoke', state: 'done' },
                ttl: APP_OP_CACHE_TTL_MS,
            },
        ]);
    });

    it('marks a completed run that did not pass `smoke_failed`', async () => {
        const cache = cacheFake();
        const r = router({ smoke: smokeFake({ state: 'done', code: null, passed: false }), cache });

        const result = await r.handle({ op: 'smoke', workId: WORK_ID, requestId: REQUEST_ID });

        expect(result).toMatchObject({ state: 'done', code: 'smoke_failed' });
        expect(cache.entries[0]?.value).toEqual({ op: 'smoke', state: 'done', code: 'smoke_failed' });
    });

    it('reports the service’s own refusal as failed with its code', async () => {
        const cache = cacheFake();
        const r = router({
            smoke: smokeFake({ state: 'refused', code: 'deployment_not_found', passed: false }),
            cache,
        });

        const result = await r.handle({ op: 'smoke', workId: WORK_ID, requestId: REQUEST_ID });

        expect(result).toMatchObject({ state: 'refused', code: 'deployment_not_found' });
        expect(cache.entries[0]?.value).toEqual({
            op: 'smoke',
            state: 'failed',
            code: 'deployment_not_found',
        });
    });

    it('names the missing service when the context has none', async () => {
        const r = router({});
        const result = await r.handle({ op: 'smoke', workId: WORK_ID, requestId: REQUEST_ID });
        expect(result).toMatchObject({
            state: 'refused',
            code: 'op_handler_unavailable',
            missing: 'AppSmokeService.run',
        });
    });

    it('refuses it on a Work that is being deleted (R-15) without running anything', async () => {
        const smoke = smokeFake({ state: 'done', code: null, passed: true });
        const r = router({ smoke, row: { deletionRequestedAt: new Date().toISOString() } });

        const result = await r.handle({ op: 'smoke', workId: WORK_ID, requestId: REQUEST_ID });

        expect(result).toMatchObject({ state: 'refused', code: 'app_work_deleting' });
        expect(smoke.run).not.toHaveBeenCalled();
    });
});
