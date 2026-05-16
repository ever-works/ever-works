import { config } from '../config';
import { DATA_SYNC_METRICS, DATA_SYNC_METRIC_NAMES } from './data-sync-metrics';

/**
 * EW-628 Phase 8 — pin the public surface of the data-sync feature
 * flags + telemetry constants. Both flag defaults are FALSE so the
 * webhook handler and dispatcher cron stay inert in production until
 * the soak window completes; the numeric tunables match
 * `docs/specs/features/data-repo-instant-sync/spec.md` §7.
 */
describe('EW-628 data-sync config + metrics (Phase 8)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {};
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('config.subscriptions.dataSync — feature flags', () => {
        it('webhookEnabled() defaults to false when DATA_SYNC_WEBHOOK_ENABLED is unset', () => {
            expect(config.subscriptions.dataSync.webhookEnabled()).toBe(false);
        });

        it('webhookEnabled() returns true only on exact "true" (case-sensitive, no truthy coercion)', () => {
            process.env.DATA_SYNC_WEBHOOK_ENABLED = 'true';
            expect(config.subscriptions.dataSync.webhookEnabled()).toBe(true);

            process.env.DATA_SYNC_WEBHOOK_ENABLED = 'True';
            expect(config.subscriptions.dataSync.webhookEnabled()).toBe(false);

            process.env.DATA_SYNC_WEBHOOK_ENABLED = '1';
            expect(config.subscriptions.dataSync.webhookEnabled()).toBe(false);
        });

        it('dispatcherEnabled() defaults to false when DATA_SYNC_DISPATCHER_ENABLED is unset', () => {
            expect(config.subscriptions.dataSync.dispatcherEnabled()).toBe(false);
        });

        it('dispatcherEnabled() returns true only on exact "true"', () => {
            process.env.DATA_SYNC_DISPATCHER_ENABLED = 'true';
            expect(config.subscriptions.dataSync.dispatcherEnabled()).toBe(true);

            process.env.DATA_SYNC_DISPATCHER_ENABLED = 'false';
            expect(config.subscriptions.dataSync.dispatcherEnabled()).toBe(false);
        });

        it('both flags toggle independently (no shared switch)', () => {
            process.env.DATA_SYNC_WEBHOOK_ENABLED = 'true';
            expect(config.subscriptions.dataSync.webhookEnabled()).toBe(true);
            expect(config.subscriptions.dataSync.dispatcherEnabled()).toBe(false);
        });
    });

    describe('config.subscriptions.dataSync — numeric tunables (spec §7 defaults)', () => {
        it('getDebounceMs() defaults to 30_000 (30s quiet-period)', () => {
            expect(config.subscriptions.dataSync.getDebounceMs()).toBe(30000);
        });

        it('getLockTtlSeconds() defaults to 300 (5min DistributedTaskLockService TTL)', () => {
            expect(config.subscriptions.dataSync.getLockTtlSeconds()).toBe(300);
        });

        it('getRetryBackoffSeconds() defaults to 300 (5min retry-after key TTL)', () => {
            expect(config.subscriptions.dataSync.getRetryBackoffSeconds()).toBe(300);
        });

        it('getSkipNoiseWindowMs() defaults to 3_600_000 (1h rate-limit for no-changes)', () => {
            expect(config.subscriptions.dataSync.getSkipNoiseWindowMs()).toBe(3600000);
        });

        it('getGenInProgressNoiseWindowMs() defaults to 900_000 (15min rate-limit for gen-in-progress)', () => {
            expect(config.subscriptions.dataSync.getGenInProgressNoiseWindowMs()).toBe(900000);
        });

        it.each([
            ['DATA_SYNC_DEBOUNCE_MS', 'getDebounceMs', '5000', 5000],
            ['DATA_SYNC_LOCK_TTL_SECONDS', 'getLockTtlSeconds', '120', 120],
            ['DATA_SYNC_RETRY_BACKOFF_SECONDS', 'getRetryBackoffSeconds', '60', 60],
            ['DATA_SYNC_SKIP_NOISE_WINDOW_MS', 'getSkipNoiseWindowMs', '7200000', 7200000],
            [
                'DATA_SYNC_GEN_IN_PROGRESS_NOISE_WINDOW_MS',
                'getGenInProgressNoiseWindowMs',
                '60000',
                60000,
            ],
        ] as const)('parses %s env override (-> %s)', (envKey, getter, raw, parsed) => {
            process.env[envKey] = raw;
            expect(
                (config.subscriptions.dataSync as unknown as Record<string, () => number>)[
                    getter
                ](),
            ).toBe(parsed);
        });
    });

    describe('DATA_SYNC_METRICS — canonical telemetry names', () => {
        it('exposes the five names locked in the spec', () => {
            expect(DATA_SYNC_METRICS).toEqual({
                successTotal: 'data_sync_success_total',
                skippedTotal: 'data_sync_skipped_total',
                failedTotal: 'data_sync_failed_total',
                durationMs: 'data_sync_duration_ms',
                lockContentionTotal: 'data_sync_lock_contention_total',
            });
        });

        it('DATA_SYNC_METRIC_NAMES exposes the values as a readonly array (dashboard tests)', () => {
            expect(DATA_SYNC_METRIC_NAMES).toHaveLength(5);
            expect(new Set(DATA_SYNC_METRIC_NAMES)).toEqual(
                new Set(Object.values(DATA_SYNC_METRICS)),
            );
        });

        it('every metric name starts with the "data_sync_" prefix (Prom/PostHog convention)', () => {
            for (const name of DATA_SYNC_METRIC_NAMES) {
                expect(name).toMatch(/^data_sync_/);
            }
        });
    });
});
