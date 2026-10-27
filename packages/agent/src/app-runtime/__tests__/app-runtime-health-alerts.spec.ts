import {
    APP_RUNTIME_RELAYED_EVENTS,
    AppRuntimeEventRelayService,
    AppRuntimeNotificationProducersAdapter,
} from '../app-runtime-worker.adapters';
import { AppRuntimeActivityListener } from '../app-runtime-activity.listener';
import {
    APP_HEALTH_EVENT_DEGRADED,
    APP_HEALTH_EVENT_RECOVERED,
    APP_HEALTH_EVENT_UNREACHABLE,
} from '../app-health.service';
import { appHostsRebuildRequester } from '../app-hosts-rebuild.requester';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';

/**
 * Lane aw-safety (2026-10-26) — APW-06 T29: the every-minute health poll now tells the owner.
 *
 * Before this the poll called three OPTIONAL producers that nothing implemented, and the relay
 * refused the three event names the poll really emits, so an App could be down for hours with no
 * notification and no Activity row.
 */

describe('the three health producers (§9.4:1337-1339)', () => {
    function adapter() {
        const created: Array<Record<string, unknown>> = [];
        const writer = {
            create: jest.fn(async (dto: Record<string, unknown>) => {
                created.push(dto);
                return dto;
            }),
        };
        return { producers: new AppRuntimeNotificationProducersAdapter(writer as never), created };
    }

    it('notifies the owner that the App is down — urgent, persistent, keyed by the streak', async () => {
        const { producers, created } = adapter();

        await producers.notifyAppUnhealthy({ userId: 'owner-1', workId: 'w-1', failureStreakStartMs: 1700 });

        expect(created).toEqual([
            expect.objectContaining({
                userId: 'owner-1',
                type: 'error',
                isPersistent: true,
                deduplicationKey: 'app-unhealthy:w-1:1700',
                actionUrl: '/works/w-1/deploy',
                metadata: expect.objectContaining({ eventKey: 'app_unhealthy', urgent: true }),
            }),
        ]);
    });

    it('sends the recovery notice under the SAME streak handle as the down notice', async () => {
        const { producers, created } = adapter();

        await producers.notifyAppRecovered({ userId: 'owner-1', workId: 'w-1', failureStreakStartMs: 1700 });

        expect(created[0]).toMatchObject({
            type: 'success',
            deduplicationKey: 'app-recovered:w-1:1700',
            metadata: { eventKey: 'app_recovered', workId: 'w-1' },
        });
        expect(created[0].isPersistent).toBeUndefined();
    });

    it('notifies that the cluster cannot be reached — urgent', async () => {
        const { producers, created } = adapter();

        await producers.notifyAppClusterUnreachable({
            userId: 'owner-1',
            workId: 'w-1',
            unreachableStreakStartMs: 99,
        });

        expect(created[0]).toMatchObject({
            deduplicationKey: 'app-cluster-unreachable:w-1:99',
            isPersistent: true,
            metadata: { eventKey: 'app_cluster_unreachable', urgent: true },
        });
    });

    it('writes nothing without a recipient (a notification with no user would be a broadcast)', async () => {
        const { producers, created } = adapter();

        await producers.notifyAppUnhealthy({ userId: '', workId: 'w-1', failureStreakStartMs: 1 });
        await producers.notifyAppRecovered({ userId: '', workId: 'w-1', failureStreakStartMs: 1 });

        expect(created).toEqual([]);
    });

    it('keeps a dedupe key stable for an unusable handle', async () => {
        const { producers, created } = adapter();

        await producers.notifyAppUnhealthy({ userId: 'u', workId: 'w', failureStreakStartMs: Number.NaN });

        expect(created[0].deduplicationKey).toBe('app-unhealthy:w:0');
    });
});

describe('the health events reach Activity', () => {
    it('lets the relay accept the three names the poll really emits', async () => {
        for (const name of [APP_HEALTH_EVENT_DEGRADED, APP_HEALTH_EVENT_RECOVERED, APP_HEALTH_EVENT_UNREACHABLE]) {
            expect(APP_RUNTIME_RELAYED_EVENTS.has(name)).toBe(true);
        }
        const emitted: Array<[string, unknown]> = [];
        const relay = new AppRuntimeEventRelayService({
            emit: (name: string, payload: unknown) => emitted.push([name, payload]),
        } as never);

        await relay.emit({ name: APP_HEALTH_EVENT_DEGRADED, payload: { workId: 'w-1', code: 'down' } });

        expect(emitted).toEqual([[APP_HEALTH_EVENT_DEGRADED, { workId: 'w-1', code: 'down' }]]);
    });

    it.each([
        ['onHealthDegraded', 'app.health.degraded', ActivityStatus.FAILED, 'App is unhealthy (down): web'],
        ['onHealthUnreachable', 'app.health.unreachable', ActivityStatus.FAILED, 'App’s cluster cannot be reached (cluster_unreachable)'],
        ['onHealthRecovered', 'app.health.recovered', ActivityStatus.COMPLETED, 'App is healthy again (healthy): web'],
    ] as const)('%s writes one APP_HEALTH row', async (handler, action, status, summary) => {
        const rows: Array<Record<string, unknown>> = [];
        const listener = new AppRuntimeActivityListener({
            log: async (row: Record<string, unknown>) => {
                rows.push(row);
                return row;
            },
        } as never);
        const payload =
            action === 'app.health.unreachable'
                ? { workId: 'w-1', userId: 'owner-1', target: 'your-cluster', code: 'cluster_unreachable' }
                : {
                      workId: 'w-1',
                      userId: 'owner-1',
                      target: 'your-cluster',
                      code: action === 'app.health.recovered' ? 'healthy' : 'down',
                      names: ['web'],
                  };

        await (listener as unknown as Record<string, (p: unknown) => Promise<void>>)[handler](payload);

        expect(rows).toEqual([
            expect.objectContaining({
                actionType: ActivityActionType.APP_HEALTH,
                action,
                status,
                summary,
                workId: 'w-1',
                userId: 'owner-1',
            }),
        ]);
    });
});

describe('appHostsRebuildRequester — APW-05 behind T26’s primary-domain change', () => {
    it('maps a queued Build onto the port’s answer', async () => {
        const builds = {
            requestRebuild: jest.fn(async () => ({
                ok: true as const,
                build: { id: 'b-1', status: 'queued' },
                deduped: false,
            })),
        };
        const requester = appHostsRebuildRequester(() => builds);

        await expect(requester.requestRebuild('w-1', { userId: 'owner-1' })).resolves.toEqual({
            build: { id: 'b-1', status: 'queued' },
            deduped: false,
            status: 'queued',
        });
        expect(builds.requestRebuild).toHaveBeenCalledWith('w-1', 'owner-1');
    });

    it('spells the rate limit the way the hosts service reads it', async () => {
        const requester = appHostsRebuildRequester(() => ({
            requestRebuild: async () => ({ ok: false as const, code: 'rebuildRateLimited' }),
        }));

        await expect(requester.requestRebuild('w-1', { userId: 'owner-1' })).resolves.toMatchObject({
            code: 'rate_limited',
        });
    });

    it('acts as the Work owner when no person asked', async () => {
        const builds = {
            requestRebuild: jest.fn(async () => ({ ok: true as const, build: { id: 'b-2' }, deduped: true })),
        };
        const requester = appHostsRebuildRequester(() => builds, {
            findById: async () => ({ userId: 'owner-9' }),
        });

        await requester.requestRebuild('w-1', { userId: null });

        expect(builds.requestRebuild).toHaveBeenCalledWith('w-1', 'owner-9');
    });

    it('throws when APW-05 is not in the container — the hosts service then refuses rebuild_unavailable', async () => {
        const requester = appHostsRebuildRequester(() => undefined);

        await expect(requester.requestRebuild('w-1', { userId: 'owner-1' })).rejects.toThrow(/not in this container/);
    });
});
