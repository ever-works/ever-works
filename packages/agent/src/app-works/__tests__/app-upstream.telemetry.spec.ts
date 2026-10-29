import { AppActionsHygieneService } from '../app-actions-hygiene.service';
import { AppForkReadinessService } from '../app-fork-readiness.service';
import { AppUpstreamSyncDispatcherService } from '../app-upstream-sync-dispatcher.service';
import { AppUpstreamSyncService } from '../app-upstream-sync.service';
import { APP_UPSTREAM_TELEMETRY_EVENTS, AppUpstreamTelemetry } from '../app-upstream.telemetry';

/**
 * APW-02 T39 (Gauzy Ever Works #37, 2026-10-29) — plan §9.1's fork lifecycle telemetry:
 * counters, durations and codes only.
 *
 * Each case drives the emitter through a path that makes no provider call, asserts the
 * event fires once with its payload, that no repository coordinate reaches the sink, and
 * that a sink which throws never changes what the run answers.
 */
describe('Fork lifecycle telemetry (APW-02 T39)', () => {
    type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };

    function sink(): { sent: Sent[]; track: (...args: unknown[]) => void } {
        const sent: Sent[] = [];
        return {
            sent,
            track: (distinctId: unknown, event: unknown, properties: unknown) =>
                sent.push({
                    distinctId: String(distinctId),
                    event: String(event),
                    properties: properties as Record<string, unknown>,
                }),
        };
    }

    const throwingSink = {
        track: () => {
            throw new Error('analytics down');
        },
    };

    const FORBIDDEN = ['acme', 'secret-widgets', 'https://', '.github/workflows'];

    function expectClean(sent: readonly Sent[]): void {
        const text = JSON.stringify(sent.map((entry) => entry.properties));
        for (const value of FORBIDDEN) {
            expect(text).not.toContain(value);
        }
    }

    it('counts and drops when unbound, never throws on a throwing sink', () => {
        const unbound = new AppUpstreamTelemetry(undefined);
        unbound.track(APP_UPSTREAM_TELEMETRY_EVENTS.checkoutNotReady, { provider: 'github' });
        expect(unbound.stats()).toMatchObject({ emitted: 0, dropped: 1 });
        const throwing = new AppUpstreamTelemetry(throwingSink);
        expect(() =>
            throwing.track(APP_UPSTREAM_TELEMETRY_EVENTS.checkoutNotReady, { provider: 'github' }),
        ).not.toThrow();
        expect(throwing.stats().failed).toBe(1);
    });

    describe('AppUpstreamSyncDispatcherService — app_upstream.dispatch_tick', () => {
        /** Every repository read answers "nothing due". */
        const emptyRows = new Proxy({}, { get: () => async () => [] });

        it('emits one tick with every counter, even when nothing was due', async () => {
            const target = sink();
            const dispatcher = new AppUpstreamSyncDispatcherService(
                emptyRows as never,
                {} as never,
                undefined,
                undefined,
                new AppUpstreamTelemetry(target),
            );

            const counters = await dispatcher.dispatchDue(Date.parse('2026-10-29T12:00:00Z'));

            expect(target.sent).toEqual([
                {
                    distinctId: 'app-works',
                    event: 'app_upstream.dispatch_tick',
                    properties: { ...counters },
                },
            ]);
            expect(Object.keys(target.sent[0].properties).sort()).toEqual(
                [
                    'dispatched',
                    'dueCount',
                    'failed',
                    'rechecked',
                    'redispatchedReadiness',
                    'setupChecked',
                    'skipped',
                    'syncPullRequestChecked',
                    'timedOut',
                ].sort(),
            );
        });

        it('a throwing sink never fails the tick', async () => {
            const dispatcher = new AppUpstreamSyncDispatcherService(
                emptyRows as never,
                {} as never,
                undefined,
                undefined,
                new AppUpstreamTelemetry(throwingSink),
            );
            await expect(dispatcher.dispatchDue()).resolves.toMatchObject({ dueCount: 0 });
        });
    });

    describe('AppActionsHygieneService — app_actions.hygiene', () => {
        function hygieneWith(target: { track: (...args: unknown[]) => void }) {
            const states = {
                findByWorkId: jest.fn(async () => ({
                    workId: 'w1',
                    relation: 'link',
                    dataOwner: 'acme',
                    dataRepo: 'secret-widgets',
                    actionsSeenWorkflowIds: [11, 12],
                })),
                update: jest.fn(async () => true),
            };
            return new AppActionsHygieneService(
                states as never,
                undefined,
                undefined,
                undefined,
                new AppUpstreamTelemetry(target),
            );
        }

        it('reports a linked repository pass as not_applicable with zero calls', async () => {
            const target = sink();

            const result = await hygieneWith(target).apply('w1');

            expect(result.state).toBe('not_applicable');
            expect(target.sent).toEqual([
                {
                    distinctId: 'app-works',
                    event: 'app_actions.hygiene',
                    properties: {
                        disabled: 0,
                        kept: 0,
                        skipped: result.seenIds.length,
                        state: 'not_applicable',
                        truncated: false,
                        calls: 0,
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('a throwing sink never fails the pass', async () => {
            await expect(hygieneWith(throwingSink).apply('w1')).resolves.toMatchObject({
                state: 'not_applicable',
            });
        });
    });

    describe('AppForkReadinessService — app_fork.readiness_finished', () => {
        function readinessWith(
            target: { track: (...args: unknown[]) => void },
            beginAttempt: () => Promise<unknown>,
        ) {
            return new AppForkReadinessService(
                { beginAttempt: jest.fn(beginAttempt) } as never,
                {} as never,
                {} as never,
                undefined,
                undefined,
                undefined,
                new AppUpstreamTelemetry(target),
            );
        }

        it('reports an attempt by its outcome and reason codes and its counters', async () => {
            const target = sink();
            const result = await readinessWith(target, async () => ({ found: false })).run(
                { workId: 'w1', attempt: 2 },
                {} as never,
            );

            expect(result).toMatchObject({ outcome: 'not_found', reason: 'state_not_found' });
            expect(target.sent).toEqual([
                {
                    distinctId: 'app-works',
                    event: 'app_fork.readiness_finished',
                    properties: {
                        attempt: 2,
                        outcome: 'not_found',
                        reason: 'state_not_found',
                        durationMs: 0,
                        probes: 0,
                        hygieneRan: false,
                    },
                },
            ]);
        });

        it('a throwing sink never fails the attempt', async () => {
            await expect(
                readinessWith(throwingSink, async () => {
                    throw new Error('state service down');
                }).run({ workId: 'w1', attempt: 1 }, {} as never),
            ).resolves.toMatchObject({ outcome: 'failed', reason: 'state_unavailable' });
        });
    });

    describe('AppUpstreamSyncService — app_upstream.sync_finished', () => {
        function syncWith(
            target: { track: (...args: unknown[]) => void },
            beginSync: () => Promise<unknown>,
        ) {
            return new AppUpstreamSyncService(
                { beginSync: jest.fn(beginSync) } as never,
                {} as never,
                {} as never,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                new AppUpstreamTelemetry(target),
            );
        }

        it('reports a run refused at the claim by its result and reason codes', async () => {
            const target = sink();
            const result = await syncWith(target, async () => ({
                allowed: false,
                reason: 'sync_in_progress',
            })).run({ workId: 'w1', trigger: 'manual' } as never);

            expect(result).toMatchObject({ outcome: 'refused', result: 'skipped' });
            expect(target.sent).toEqual([
                {
                    distinctId: 'app-works',
                    event: 'app_upstream.sync_finished',
                    properties: {
                        trigger: 'manual',
                        result: 'skipped',
                        reason: 'sync_in_progress',
                        commits: null,
                        providerCalls: 0,
                        durationMs: expect.any(Number),
                        outcome: 'refused',
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('a throwing sink never fails the run', async () => {
            await expect(
                syncWith(throwingSink, async () => null).run({
                    workId: 'w1',
                    trigger: 'schedule',
                } as never),
            ).resolves.toMatchObject({ result: 'failed', reason: 'state_unavailable' });
        });
    });
});
