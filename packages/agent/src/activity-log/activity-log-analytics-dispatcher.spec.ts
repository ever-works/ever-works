import {
    ACTIVITY_LOG_ANALYTICS_DISPATCHER,
    type ActivityLogAnalyticsDispatcher,
} from './activity-log-analytics-dispatcher';
import * as activityLogBarrel from './index';

/**
 * The `ActivityLogAnalyticsDispatcher` surface is contracts-only:
 *
 *   1. `ACTIVITY_LOG_ANALYTICS_DISPATCHER` — a string DI token used by
 *      `ActivityLogService` to look up an optional analytics sink (Jitsu
 *      in `apps/api/src/activity-log/jitsu.service.ts`); when no provider
 *      is bound it falls back to a no-op so the activity-log path keeps
 *      working in isolation.
 *   2. `ActivityLogAnalyticsDispatcher` — a single-method interface
 *      (`track(activity): Promise<void>`) consumed via constructor
 *      injection. The string-token shape (NOT a `Symbol(...)`) is
 *      DELIBERATE: NestJS modules in `apps/api` bind the same string
 *      from their own `@Inject(ACTIVITY_LOG_ANALYTICS_DISPATCHER)`
 *      decorators, and string-token equality is what makes that work
 *      across module boundaries.
 *
 * This suite pins the token literal + barrel re-export + the runtime
 * shape of a conforming implementation so a future swap to `Symbol(...)`
 * (which would silently break every cross-module bind) is a deliberate
 * change.
 */
describe('ActivityLogAnalyticsDispatcher contract', () => {
    describe('ACTIVITY_LOG_ANALYTICS_DISPATCHER token', () => {
        it('is a string literal — NOT a Symbol — so cross-module @Inject() bindings match', () => {
            // Pinned because Symbol-based DI tokens are NOT shared across the
            // agent-package and apps/api compilation units, but the same
            // string IS shared via `import` from the barrel. A future swap
            // to `Symbol(...)` would break every consumer's @Inject().
            expect(typeof ACTIVITY_LOG_ANALYTICS_DISPATCHER).toBe('string');
        });

        it('uses the documented literal value', () => {
            expect(ACTIVITY_LOG_ANALYTICS_DISPATCHER).toBe('ACTIVITY_LOG_ANALYTICS_DISPATCHER');
        });

        it('is non-empty (truthy) so it can be used as a NestJS injection key', () => {
            expect(ACTIVITY_LOG_ANALYTICS_DISPATCHER).toBeTruthy();
            expect((ACTIVITY_LOG_ANALYTICS_DISPATCHER as string).length).toBeGreaterThan(0);
        });

        it('re-importing the module returns the same singleton string', () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const reimported =
                require('./activity-log-analytics-dispatcher').ACTIVITY_LOG_ANALYTICS_DISPATCHER;
            expect(reimported).toBe(ACTIVITY_LOG_ANALYTICS_DISPATCHER);
        });
    });

    describe('ActivityLogAnalyticsDispatcher interface (runtime mock contract)', () => {
        it('a conforming implementation forwards the activity verbatim and returns Promise<void>', async () => {
            const track = jest.fn().mockResolvedValue(undefined);
            const dispatcher: ActivityLogAnalyticsDispatcher = { track };

            const activity = {
                id: 'activity-1',
                userId: 'user-1',
                actionType: 'work_created',
                status: 'completed',
            } as never;

            const result = await dispatcher.track(activity);

            expect(track).toHaveBeenCalledTimes(1);
            expect(track).toHaveBeenCalledWith(activity);
            expect(result).toBeUndefined();
        });

        it('rejection from track() propagates — the agent-side activity-log service is responsible for swallowing', async () => {
            // Pinned because the documented contract is "track returns Promise<void>"
            // — error handling lives at the calling site (Jitsu adapter / activity
            // listener), NOT inside the interface itself.
            const boom = new Error('analytics provider down');
            const track = jest.fn().mockRejectedValueOnce(boom);
            const dispatcher: ActivityLogAnalyticsDispatcher = { track };

            await expect(dispatcher.track({} as never)).rejects.toBe(boom);
        });
    });

    describe('barrel re-export', () => {
        it('re-exports the DI-token from the activity-log/index.ts barrel', () => {
            expect(
                (activityLogBarrel as unknown as Record<string, unknown>)
                    .ACTIVITY_LOG_ANALYTICS_DISPATCHER,
            ).toBe(ACTIVITY_LOG_ANALYTICS_DISPATCHER);
        });
    });
});
