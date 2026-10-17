jest.mock('../../config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));

import { config } from '../../config';
import { AppEnvChangedEvent, AppEnvRotatedEvent } from '../../events/app-env.events';
import { APP_ENV_REDEPLOY_DEBOUNCE_MS, AppEnvRedeployListener } from '../app-env-redeploy.listener';

/**
 * 2026-10-17 (lane aw-env-redeploy) — a runtime-phase App env change redeploys
 * the Work's live Deployment, once per 30 s window, through
 * `AppDeployRequestService.request` (trigger `env-changed`).
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const BUILD_ID = '44444444-4444-4444-8444-444444444444';
const worksEnabled = (config as unknown as { everWorks: { apps: { worksEnabled: jest.Mock } } })
    .everWorks.apps.worksEnabled;

function changed(runtime: string[], build: string[] = []) {
    return new AppEnvChangedEvent({
        workId: WORK_ID,
        names: [...new Set([...runtime, ...build])],
        buildPhaseNames: build,
        runtimePhaseNames: runtime,
    });
}

function harness(
    options: {
        target?: string | null;
        autoDeploy?: boolean;
        deployments?: Array<Record<string, unknown>>;
        openBuilds?: unknown[];
    } = {},
) {
    const request = jest.fn(async () => ({ status: 'dispatched', code: null }) as never);
    const states = {
        getOrCreate: jest.fn(async () => ({
            target: options.target === undefined ? 'your-cluster' : options.target,
            targetSettings: { autoDeploy: options.autoDeploy ?? true },
        })),
    };
    const deployments = {
        findByWork: jest.fn(
            async () =>
                options.deployments ?? [
                    { id: 'dep-new', appTarget: 'your-cluster', state: 'FAILED', buildId: 'other' },
                    {
                        id: 'dep-live',
                        appTarget: 'your-cluster',
                        state: 'READY',
                        buildId: BUILD_ID,
                        branch: 'main',
                        appRender: { specCommitSha: 'c'.repeat(40) },
                    },
                ],
        ),
    };
    const builds = {
        findPage: jest.fn(async () => ({
            rows: options.openBuilds ?? [],
            total: 0,
            page: 1,
            pageSize: 1,
            hasMore: false,
        })),
    };
    const listener = new AppEnvRedeployListener(
        { request } as never,
        states as never,
        deployments as never,
        builds as never,
    );
    return { listener, request, states, deployments, builds };
}

describe('AppEnvRedeployListener', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        worksEnabled.mockReturnValue(true);
    });
    afterEach(() => jest.useRealTimers());

    async function flush(): Promise<void> {
        jest.advanceTimersByTime(APP_ENV_REDEPLOY_DEBOUNCE_MS + 1);
        // Let the window's async decision settle.
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }

    it('a batch of runtime saves inside 30 s redeploys the live Deployment once', async () => {
        const h = harness();
        h.listener.onEnvChanged(changed(['API_URL']));
        jest.advanceTimersByTime(5_000);
        h.listener.onEnvChanged(changed(['SMTP_HOST']));
        h.listener.onEnvRotated(
            new AppEnvRotatedEvent({
                workId: WORK_ID,
                names: ['KEY'],
                buildPhaseNames: [],
                runtimePhaseNames: ['KEY'],
            }),
        );
        expect(h.request).not.toHaveBeenCalled();

        await flush();

        expect(h.request).toHaveBeenCalledTimes(1);
        expect(h.request).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                userId: null,
                trigger: 'env-changed',
                buildId: BUILD_ID,
                branch: 'main',
                specCommitSha: 'c'.repeat(40),
                requestId: expect.stringMatching(new RegExp(`^app-env:${WORK_ID}:\\d+$`)),
            }),
        );
    });

    it('a build-only change requests nothing (the next Build carries it)', async () => {
        const h = harness();
        h.listener.onEnvChanged(changed([], ['NEXT_PUBLIC_URL']));
        await flush();
        expect(h.request).not.toHaveBeenCalled();
    });

    it('skips when a push or manual Build is open — it auto-deploys with the new values', async () => {
        const h = harness({ openBuilds: [{ id: 'b-open' }] });
        await expect(h.listener.redeploy(WORK_ID, 1, ['API_URL'])).resolves.toEqual({
            requested: false,
            reason: 'build_pending',
        });
        expect(h.builds.findPage).toHaveBeenCalledWith(
            WORK_ID,
            { status: ['queued', 'running'], trigger: ['push', 'manual'] },
            1,
            1,
        );
        expect(h.request).not.toHaveBeenCalled();
    });

    it('skips with no live Deployment, no target, or auto-deploy off', async () => {
        const none = harness({
            deployments: [{ id: 'd', appTarget: 'your-cluster', state: 'FAILED' }],
        });
        await expect(none.listener.redeploy(WORK_ID, 1, ['A'])).resolves.toEqual({
            requested: false,
            reason: 'no_live_deployment',
        });

        const noTarget = harness({ target: 'none' });
        await expect(noTarget.listener.redeploy(WORK_ID, 1, ['A'])).resolves.toEqual({
            requested: false,
            reason: 'target_none',
        });

        const off = harness({ autoDeploy: false });
        await expect(off.listener.redeploy(WORK_ID, 1, ['A'])).resolves.toEqual({
            requested: false,
            reason: 'auto_deploy_off',
        });

        for (const h of [none, noTarget, off]) expect(h.request).not.toHaveBeenCalled();
    });

    it('does nothing while App Works is off', async () => {
        worksEnabled.mockReturnValue(false);
        const h = harness();
        h.listener.onEnvChanged(changed(['API_URL']));
        await flush();
        expect(h.request).not.toHaveBeenCalled();
    });

    it('a new window after the first one fires asks again (a later batch is a later redeploy)', async () => {
        const h = harness();
        h.listener.onEnvChanged(changed(['A']));
        await flush();
        h.listener.onEnvChanged(changed(['B']));
        await flush();
        expect(h.request).toHaveBeenCalledTimes(2);
    });

    it('never throws into the emitter when the request fails', async () => {
        const h = harness();
        h.request.mockRejectedValueOnce(new Error('dispatcher down'));
        h.listener.onEnvChanged(changed(['A']));
        await expect(flush()).resolves.toBeUndefined();
    });
});
