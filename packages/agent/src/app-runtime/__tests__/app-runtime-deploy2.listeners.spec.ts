/**
 * Lane aw-deploy-2 (2026-10-17) — T28's Activity listener, T35's spec-applied trigger, APW-07
 * T25's dependency spec source and the dependency worker's row relay.
 */

import { Logger } from '@nestjs/common';

import { config } from '../../config';
import { AppDependencySpecSourceAdapter } from '../../app-dependencies/app-dependency-spec.source';
import { AppDependencyRowsRelay } from '../../app-dependencies/app-dependency-worker.relays';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import { AppSpecAppliedEvent } from '../../events/app-spec-applied.event';
import { AppRuntimeActivityListener } from '../app-runtime-activity.listener';
import { APP_IMAGE_REDEPLOY_BLOCKS, AppSpecAppliedListener } from '../app-spec-applied.listener';

beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('AppRuntimeActivityListener (T28)', () => {
    it('writes one app_deploy row per relayed event, ids and names only, owner as the user', async () => {
        const log = jest.fn(async () => ({}));
        const listener = new AppRuntimeActivityListener(
            { log } as never,
            {
                findById: async () => ({ id: 'w-1', userId: 'owner-1' }),
            } as never,
        );

        await listener.onDeploySucceeded({
            workId: 'w-1',
            deploymentId: 'd-1',
            target: 'your-cluster',
            value: 'x',
        });
        await listener.onDeployFailed({
            workId: 'w-1',
            userId: 'u-2',
            deploymentId: 'd-2',
            code: 'image_pull',
        });
        await listener.onJobFailed({ workId: 'w-1', userId: 'u-2', names: ['migrate'] });

        expect(log).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                userId: 'owner-1',
                workId: 'w-1',
                actionType: ActivityActionType.APP_DEPLOY,
                action: 'app.deploy.succeeded',
                status: ActivityStatus.COMPLETED,
                metadata: { deploymentId: 'd-1', target: 'your-cluster' },
            }),
        );
        expect(log).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                userId: 'u-2',
                status: ActivityStatus.FAILED,
                metadata: { deploymentId: 'd-2', code: 'image_pull' },
            }),
        );
        expect(log).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                actionType: ActivityActionType.APP_JOB,
                metadata: { names: ['migrate'] },
            }),
        );
    });

    it('never throws when the write fails', async () => {
        const listener = new AppRuntimeActivityListener({
            log: async () => {
                throw new Error('db');
            },
        } as never);
        await expect(
            listener.onSmokePassed({ workId: 'w-1', userId: 'u' }),
        ).resolves.toBeUndefined();
    });
});

describe('AppSpecAppliedListener (T35, spec-applied)', () => {
    let enabled: jest.SpyInstance;
    beforeEach(() => {
        enabled = jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
    });
    afterEach(() => enabled.mockRestore());

    const event = (changedBlocks: string[]) =>
        new AppSpecAppliedEvent({
            workId: 'w-1',
            commitSha: 'c'.repeat(40),
            previousCommitSha: null,
            specHash: 'h',
            addedDependencies: [],
            changedEnvNames: [],
            changedBlocks,
        });

    function harness(
        strategy: string,
        state: Record<string, unknown> = { target: 'your-cluster' },
    ) {
        const request = jest.fn(async () => ({ status: 'accepted' }) as never);
        const listener = new AppSpecAppliedListener(
            { request } as never,
            { getOrCreate: async () => state } as never,
            {
                getEffectiveSpec: async () => ({ status: 'valid', spec: { build: { strategy } } }),
            } as never,
            { findByWork: async () => [] } as never,
        );
        return { listener, request };
    }

    it('redeploys a published image when a block that runs changed', async () => {
        const { listener, request } = harness('image');
        await expect(listener.onSpecApplied(event(['components']))).resolves.toMatchObject({
            requested: true,
        });
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: 'w-1',
                trigger: 'spec-applied',
                specCommitSha: 'c'.repeat(40),
            }),
        );
        expect(APP_IMAGE_REDEPLOY_BLOCKS).toContain('env');
    });

    it('requests nothing for a dockerfile App, autoDeploy off, target none, or nothing that runs changing', async () => {
        const cases: Array<[ReturnType<typeof harness>, string[], string]> = [
            [harness('dockerfile'), ['components'], 'not_image_strategy'],
            [
                harness('image', { target: 'your-cluster', targetSettings: { autoDeploy: false } }),
                ['env'],
                'auto_deploy_off',
            ],
            [harness('image', { target: 'none' }), ['env'], 'target_none'],
            [harness('image'), ['metadata'], 'nothing_that_runs_changed'],
        ];
        for (const [{ listener, request }, blocks, reason] of cases) {
            await expect(listener.onSpecApplied(event(blocks))).resolves.toEqual({
                requested: false,
                reason,
            });
            expect(request).not.toHaveBeenCalled();
        }
    });
});

describe('AppDependencySpecSourceAdapter (APW-07 T25)', () => {
    it('reads the declared dependencies, the target and the app name; smtp only when required', async () => {
        const source = new AppDependencySpecSourceAdapter(
            {
                getEffectiveSpec: async () => ({
                    status: 'valid',
                    spec: {
                        dependencies: { postgres: { version: '16' }, smtp: { required: false } },
                    },
                }),
            } as never,
            { getOrCreate: async () => ({ target: 'your-cluster' }) },
            { findById: async () => ({ id: 'w-1', slug: 'acme' }) } as never,
        );

        await expect(source.read('w-1')).resolves.toEqual({
            deployTarget: 'your-cluster',
            appName: 'acme',
            dependencies: [
                { kind: 'postgres', declared: { version: '16' }, required: true },
                { kind: 'smtp', declared: { required: false }, required: false },
            ],
        });
    });

    it('answers null for an unusable or unreadable spec', async () => {
        const invalid = new AppDependencySpecSourceAdapter({
            getEffectiveSpec: async () => ({ status: 'invalid' }),
        } as never);
        await expect(invalid.read('w-1')).resolves.toBeNull();
        const throwing = new AppDependencySpecSourceAdapter({
            getEffectiveSpec: async () => {
                throw new Error('git');
            },
        } as never);
        await expect(throwing.read('w-1')).resolves.toBeNull();
    });
});

describe('AppDependencyRowsRelay (the worker’s raw row writes)', () => {
    it('is id-scoped: no free-form query, and a patch cannot move a row', async () => {
        const update = jest.fn(async () => ({ affected: 1 }));
        const findOne = jest.fn(async () => ({ id: 'r-1' }));
        const relay = new AppDependencyRowsRelay({ update, findOne, insert: jest.fn() } as never);

        await expect(relay.findOne({ where: { id: 'r-1' } })).resolves.toEqual({ id: 'r-1' });
        await expect(relay.findOne({ where: {} })).resolves.toBeNull();
        await expect(
            relay.update({ id: 'r-1' }, { status: 'ready', workId: 'other', kind: 'redis' }),
        ).resolves.toEqual({
            affected: 1,
        });
        expect(update).toHaveBeenCalledWith({ id: 'r-1' }, { status: 'ready' });
        await expect(relay.update({}, { status: 'x' })).rejects.toThrow(/scoped by id/);
    });
});
