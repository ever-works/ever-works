import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import { AppRuntimeActivityListener } from '../app-runtime-activity.listener';
import {
    APP_RUNTIME_RELAYED_EVENTS,
    AppRuntimeEventRelayService,
} from '../app-runtime-worker.adapters';

/**
 * Lane aw-builds-bindings (2026-10-27) — APW-07's dependency lifecycle events.
 *
 * `AppDependenciesService.emit` sends CONTRACTS §6's four names, but the relay catalogued only
 * `app.dependency.failed` (beside three names nobody emits), so a worker's "Postgres is ready",
 * every release and every data deletion was refused at the relay, and no listener wrote a row for
 * any of them. These pin the catalogue to the names really emitted, and one `app_dependency`
 * Activity row per event, carrying ids and names only.
 */
describe('App dependency lifecycle events', () => {
    const EMITTED = [
        'app.dependency.provisioned',
        'app.dependency.failed',
        'app.dependency.released',
        'app.dependency.data_deleted',
    ];

    it('catalogues every name AppDependenciesService really emits, and keeps the older three', () => {
        for (const name of EMITTED) {
            expect(APP_RUNTIME_RELAYED_EVENTS.has(name)).toBe(true);
        }
        // Additive: the three earlier names stay catalogued.
        for (const name of [
            'app.dependency.ready',
            'app.dependency.failed',
            'app.dependency.removed',
        ]) {
            expect(APP_RUNTIME_RELAYED_EVENTS.has(name)).toBe(true);
        }
    });

    it('relays a provisioned event to the emitter, and still refuses a payload with a value in it', async () => {
        const emitted: Array<[string, unknown]> = [];
        const relay = new AppRuntimeEventRelayService({
            emit: (name: string, payload: unknown) => emitted.push([name, payload]),
        } as never);

        await relay.emit({
            name: 'app.dependency.provisioned',
            payload: { workId: 'w1', kind: 'postgres', providerId: 'cnpg', actualVersion: '16' },
        });
        expect(emitted).toEqual([
            [
                'app.dependency.provisioned',
                { workId: 'w1', kind: 'postgres', providerId: 'cnpg', actualVersion: '16' },
            ],
        ]);

        await expect(
            relay.emit({
                name: 'app.dependency.provisioned',
                payload: { workId: 'w1', kind: 'postgres', password: 'hunter2' },
            }),
        ).rejects.toThrow(/forbidden key 'password'/);
        expect(emitted).toHaveLength(1);
    });

    function listenerWithRows(): {
        listener: AppRuntimeActivityListener;
        rows: Array<Record<string, unknown>>;
    } {
        const rows: Array<Record<string, unknown>> = [];
        const listener = new AppRuntimeActivityListener(
            {
                log: async (row: Record<string, unknown>) => {
                    rows.push(row);
                    return row;
                },
            } as never,
            { findById: async () => ({ id: 'w1', userId: 'owner-1' }) } as never,
        );
        return { listener, rows };
    }

    it('writes one app_dependency row per event, attributed to the Work owner', async () => {
        const { listener, rows } = listenerWithRows();

        await listener.onDependencyProvisioned({
            workId: 'w1',
            kind: 'postgres',
            providerId: 'cnpg',
            actualVersion: '16',
        });
        await listener.onDependencyFailed({
            workId: 'w1',
            kind: 'redis',
            providerId: 'redis-in-namespace',
            reason: 'clusterUnreachable',
        });
        await listener.onDependencyReleased({
            workId: 'w1',
            kind: 'objectStorage',
            providerId: 'minio',
            kept: ['PersistentVolumeClaim/data-minio-0'],
        });
        await listener.onDependencyDataDeleted({ workId: 'w1', kind: 'postgres', providerId: 'cnpg' });

        expect(rows.map((row) => [row.action, row.actionType, row.status, row.userId])).toEqual([
            [
                'app.dependency.provisioned',
                ActivityActionType.APP_DEPENDENCY,
                ActivityStatus.COMPLETED,
                'owner-1',
            ],
            [
                'app.dependency.failed',
                ActivityActionType.APP_DEPENDENCY,
                ActivityStatus.FAILED,
                'owner-1',
            ],
            [
                'app.dependency.released',
                ActivityActionType.APP_DEPENDENCY,
                ActivityStatus.COMPLETED,
                'owner-1',
            ],
            [
                'app.dependency.data_deleted',
                ActivityActionType.APP_DEPENDENCY,
                ActivityStatus.COMPLETED,
                'owner-1',
            ],
        ]);
        expect(rows.map((row) => row.summary)).toEqual([
            'postgres is ready (version 16)',
            'redis failed (clusterUnreachable)',
            'objectStorage released: kept, no longer managed',
            'postgres data deleted',
        ]);
        expect(rows[0].metadata).toEqual({
            kind: 'postgres',
            providerId: 'cnpg',
            actualVersion: '16',
        });
        expect(rows[2].metadata).toEqual({
            kind: 'objectStorage',
            providerId: 'minio',
            kept: ['PersistentVolumeClaim/data-minio-0'],
        });
    });

    it('copies only the named keys — an unexpected payload key never reaches the row', async () => {
        const { listener, rows } = listenerWithRows();
        await listener.onDependencyProvisioned({
            workId: 'w1',
            kind: 'postgres',
            providerId: 'cnpg',
            connectionString: 'postgres://user:pw@host/db',
        });
        expect(JSON.stringify(rows)).not.toContain('postgres://');
    });

    it('leaves the metadata of every other family as it was (no dependency keys)', async () => {
        const { listener, rows } = listenerWithRows();
        await listener.onDeploySucceeded({
            workId: 'w1',
            deploymentId: 'd1',
            kind: 'should-not-be-copied',
            providerId: 'should-not-be-copied',
        });
        expect(rows[0].metadata).toEqual({ deploymentId: 'd1' });
    });
});
