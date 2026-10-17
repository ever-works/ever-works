import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-02 T34 — the `app-upstream-sync-dispatcher` cron (plan §6.6).
 *
 * Pinned: the default cron when the variable is unset, a valid five-field override
 * honoured, an invalid one falling back; and the tick calling `dispatchDue()` — with NO
 * argument, so the API reads its own clock — on the proxy `TriggerInternalModule`
 * provides, and returning its counters.
 */

const h = vi.hoisted(() => ({
    recorded: [] as Array<Record<string, unknown>>,
    dispatchDue: vi.fn(),
    close: vi.fn(async () => undefined),
}));

vi.mock('@trigger.dev/sdk', () => ({
    schedules: {
        task: (params: Record<string, unknown>) => {
            h.recorded.push(params);
            return params;
        },
    },
}));
vi.mock('@nestjs/core', () => ({
    NestFactory: {
        createApplicationContext: vi.fn(async () => ({
            useLogger: vi.fn(),
            get: vi.fn((token: unknown) => {
                if (token === 'AppUpstreamSyncDispatcherService') {
                    return { dispatchDue: h.dispatchDue };
                }
                throw new Error(`no provider ${String(token)}`);
            }),
            close: h.close,
        })),
    },
}));
vi.mock('../../../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: class TriggerInternalModule {},
    APP_UPSTREAM_SYNC_DISPATCHER_SERVICE: 'AppUpstreamSyncDispatcherService',
}));
vi.mock('../../../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: () => ({}),
}));

import {
    DEFAULT_APP_UPSTREAM_SYNC_DISPATCHER_CRON,
    resolveAppUpstreamSyncDispatcherCron,
    runAppUpstreamSyncDispatcherTick,
} from '../app-upstream-sync-dispatcher.task';

describe('app-upstream-sync-dispatcher (APW-02 T34)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('registers the cron under plan §6.6’s id', () => {
        const registered = h.recorded.find((entry) => entry.id === 'app-upstream-sync-dispatcher');
        expect(registered).toBeDefined();
        expect(typeof registered?.cron).toBe('string');
    });

    it('uses */10 * * * * when the variable is unset', () => {
        expect(DEFAULT_APP_UPSTREAM_SYNC_DISPATCHER_CRON).toBe('*/10 * * * *');
        expect(resolveAppUpstreamSyncDispatcherCron(undefined)).toBe('*/10 * * * *');
    });

    it('honours a valid five-field override', () => {
        expect(resolveAppUpstreamSyncDispatcherCron('*/5 * * * *')).toBe('*/5 * * * *');
        expect(resolveAppUpstreamSyncDispatcherCron('  0 */2 * * 1-5 ')).toBe('0 */2 * * 1-5');
    });

    it.each(['', 'every ten minutes', '* * * * * *', '*/5 * * *', '0 0 * * MON'])(
        'falls back to the default for the invalid override %p',
        (raw) => {
            expect(resolveAppUpstreamSyncDispatcherCron(raw)).toBe('*/10 * * * *');
        },
    );

    it('calls dispatchDue() with no argument on the proxy and returns its counters', async () => {
        const counters = {
            dueCount: 2,
            dispatched: 1,
            redispatchedReadiness: 0,
            timedOut: 0,
            rechecked: 0,
            setupChecked: 1,
            failed: 0,
            skipped: 1,
        };
        h.dispatchDue.mockResolvedValue(counters);

        const result = await runAppUpstreamSyncDispatcherTick();

        expect(h.dispatchDue).toHaveBeenCalledTimes(1);
        expect(h.dispatchDue).toHaveBeenCalledWith();
        expect(result).toMatchObject(counters);
        expect(h.close).toHaveBeenCalledTimes(1);
    });

    it('closes the context even when the tick fails', async () => {
        h.dispatchDue.mockRejectedValue(new Error('Unknown remote target'));

        await expect(runAppUpstreamSyncDispatcherTick()).rejects.toThrow('Unknown remote target');
        expect(h.close).toHaveBeenCalledTimes(1);
    });
});
