/**
 * APW-06 T35 (A0.6) — `AppBuildSucceededListener`: a green deployable Build requests exactly one
 * Deployment when `autoDeploy` is on (or a domain rebuild is pending), and nothing otherwise
 * (ACC-06-01: target `none` makes zero deploy requests).
 */

import { Logger } from '@nestjs/common';

import { config } from '../../config';
import { AppBuildSucceededEvent } from '../../events/app-build.events';
import { AppBuildSucceededListener } from '../app-build-succeeded.listener';

const payload = (over: Record<string, unknown> = {}) =>
    ({
        workId: 'w-1',
        userId: 'u-1',
        buildId: 'b-1',
        number: 7,
        status: 'succeeded',
        trigger: 'push',
        branch: 'main',
        commitSha: 'c'.repeat(40),
        pullRequestNumber: null,
        deployable: true,
        notDeployableReason: null,
        imageDigest: null,
        failureClass: null,
        cancelReason: null,
        ...over,
    }) as never;

function harness(state: Record<string, unknown> | null, rows: Array<Record<string, unknown>> = []) {
    const request = jest.fn(async () => ({
        status: 'accepted' as const,
        httpStatus: 202,
        code: null,
        deploymentId: 'd-1',
        queuedDeploymentId: null,
        queuedBuildId: null,
    }));
    const states = {
        getOrCreate: jest.fn(async () => state),
        clearPendingDomainRebuild: jest.fn(async () => true),
    };
    const deployments = { findByWork: jest.fn(async () => rows) };
    const listener = new AppBuildSucceededListener(
        { request } as never,
        states,
        deployments as never,
    );
    return { listener, request, states, deployments };
}

describe('AppBuildSucceededListener (T35)', () => {
    let enabled: jest.SpyInstance;

    beforeAll(() => {
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    beforeEach(() => {
        enabled = jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
    });

    afterEach(() => enabled.mockRestore());

    it('requests one build-triggered Deployment for a deployable Build with autoDeploy on (default)', async () => {
        const { listener, request } = harness({ target: 'your-cluster', targetSettings: {} });

        const outcome = await listener.onBuildSucceeded(new AppBuildSucceededEvent(payload()));

        expect(outcome).toMatchObject({ requested: true, trigger: 'build' });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: 'w-1',
                trigger: 'build',
                buildId: 'b-1',
                userId: null,
            }),
        );
    });

    it('target none makes zero deploy requests (ACC-06-01)', async () => {
        const { listener, request } = harness({ target: 'none' });
        await expect(listener.onBuildSucceeded(payload())).resolves.toEqual({
            requested: false,
            reason: 'target_none',
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('a non-deployable Build, autoDeploy off, or App Works off requests nothing', async () => {
        const notDeployable = harness({ target: 'your-cluster' });
        await notDeployable.listener.onBuildSucceeded(payload({ deployable: false }));
        expect(notDeployable.request).not.toHaveBeenCalled();

        const off = harness({ target: 'your-cluster', targetSettings: { autoDeploy: false } });
        await expect(off.listener.onBuildSucceeded(payload())).resolves.toMatchObject({
            reason: 'auto_deploy_off',
        });
        expect(off.request).not.toHaveBeenCalled();

        enabled.mockReturnValue(false);
        const disabled = harness({ target: 'your-cluster' });
        await disabled.listener.onBuildSucceeded(payload());
        expect(disabled.request).not.toHaveBeenCalled();
    });

    it('is idempotent: a Build already deployed by a build trigger is not requested again', async () => {
        const { listener, request } = harness({ target: 'your-cluster' }, [
            { id: 'd-0', buildId: 'b-1', appTrigger: 'build' },
        ]);
        await expect(listener.onBuildSucceeded(payload())).resolves.toMatchObject({
            reason: 'already_requested',
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('a pending domain rebuild deploys as domain-change even with autoDeploy off, then clears the marker', async () => {
        const { listener, request, states } = harness({
            target: 'your-cluster',
            pendingDomainRebuildBuildId: 'b-1',
            targetSettings: { autoDeploy: false },
        });

        await expect(listener.onBuildSucceeded(payload())).resolves.toMatchObject({
            requested: true,
            trigger: 'domain-change',
        });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'domain-change' }));
        expect(states.clearPendingDomainRebuild).toHaveBeenCalledWith('w-1', 'b-1');
    });

    it('a failed or cancelled marked Build clears the marker and requests nothing (APW06-G11)', async () => {
        const { listener, request, states } = harness({
            target: 'your-cluster',
            pendingDomainRebuildBuildId: 'b-1',
        });

        await listener.onBuildFailed(payload({ status: 'failed' }));
        await listener.onBuildCancelled(payload({ status: 'cancelled', buildId: 'b-2' }));

        expect(states.clearPendingDomainRebuild).toHaveBeenCalledTimes(1);
        expect(states.clearPendingDomainRebuild).toHaveBeenCalledWith('w-1', 'b-1');
        expect(request).not.toHaveBeenCalled();
    });

    it('never throws into the Build event fan-out', async () => {
        const { listener, request } = harness({ target: 'your-cluster' });
        request.mockRejectedValueOnce(new Error('boom'));
        await expect(listener.onBuildSucceeded(payload())).resolves.toEqual({
            requested: false,
            reason: 'threw',
        });
    });
});
