import { describe, it, expect } from 'vitest';
import { workerAppHealthEgressSource } from '../trigger-app-runtime.module';

/**
 * **The isolated worker's `APP_HEALTH_EGRESS_SOURCE`** (lane aw-builds-bindings, 2026-10-27).
 *
 * APW-06 §9.3's every-10th health poll re-resolves an App's dependency egress hosts and dispatches
 * an ingress/DNS reconcile on drift. The port was unbound in the worker, so every 10th poll only
 * logged `egress_source_unavailable`. It is now a one-member adapter over the API's
 * `AppEnvRuntimeSource.resolveEgressHosts`, reached through the `APP_RUNTIME_ENV_SOURCE` proxy.
 *
 * Pinned here: the work id and the polled target are forwarded, only string hosts come back, and
 * every failure is `null` ("cannot be answered") — never `[]`, which the health service would read
 * as "no egress hosts" and compare against the last set, dispatching a reconcile on a transport
 * error.
 */
describe('workerAppHealthEgressSource', () => {
    it('forwards the work id and the target, and answers the hosts', async () => {
        const calls: unknown[][] = [];
        const source = workerAppHealthEgressSource({
            resolveEgressHosts: async (...args: unknown[]) => {
                calls.push(args);
                return ['smtp.mail.test', 's3.example.test'];
            },
        });

        expect(await source.resolveEgressHosts('w1', 'your-cluster')).toEqual([
            'smtp.mail.test',
            's3.example.test',
        ]);
        expect(calls).toEqual([['w1', 'your-cluster']]);
    });

    it('passes a missing target on as null', async () => {
        const calls: unknown[][] = [];
        const source = workerAppHealthEgressSource({
            resolveEgressHosts: async (...args: unknown[]) => {
                calls.push(args);
                return [];
            },
        });
        expect(await source.resolveEgressHosts('w1')).toEqual([]);
        expect(calls).toEqual([['w1', null]]);
    });

    it('answers null — never [] — when the channel fails or answers nothing usable', async () => {
        const throwing = workerAppHealthEgressSource({
            resolveEgressHosts: async () => {
                throw new Error('502 from the internal channel');
            },
        });
        expect(await throwing.resolveEgressHosts('w1', 'your-cluster')).toBeNull();

        const unknown = workerAppHealthEgressSource({ resolveEgressHosts: async () => null });
        expect(await unknown.resolveEgressHosts('w1', 'your-cluster')).toBeNull();

        const malformed = workerAppHealthEgressSource({
            resolveEgressHosts: async () => 'not-a-list',
        });
        expect(await malformed.resolveEgressHosts('w1', 'your-cluster')).toBeNull();

        expect(await workerAppHealthEgressSource(undefined).resolveEgressHosts('w1')).toBeNull();
    });

    it('drops anything in the answer that is not a host string', async () => {
        const source = workerAppHealthEgressSource({
            resolveEgressHosts: async () => ['smtp.mail.test', 42, { host: 'x' }],
        });
        expect(await source.resolveEgressHosts('w1', 'your-cluster')).toEqual(['smtp.mail.test']);
    });
});
