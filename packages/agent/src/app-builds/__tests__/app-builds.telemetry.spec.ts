import {
    APP_BUILD_TELEMETRY_EVENTS,
    AppBuildsTelemetry,
    AppBuildsTelemetryListener,
    appBuildDurationBucket,
    appBuildWorkflowWrittenPath,
} from '../app-builds.telemetry';
import { AppBuildPrepareRunner } from '../app-build-prepare.runner';
import { pullTokenTelemetryResultFor } from '../app-build-pull-token.service';

/**
 * APW-05 T38 (C-17, lane aw-builds-bindings, 2026-10-27) — plan §9.1's Builds telemetry.
 *
 * The Done-when of T38: "no event payload contains an env name, a check name or command, a
 * repository name, a commit message, a log line or a token". Every case below feeds the
 * emitters inputs that DO carry those things, and asserts that only codes, counters and flags
 * reach the sink.
 */
describe('Builds telemetry (APW-05 T38)', () => {
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

    /** Everything a leak would look like; none of it may appear in any payload. */
    const FORBIDDEN = [
        'DATABASE_URL',
        'lint-and-test',
        'pnpm test --ci',
        'acme/secret-widgets',
        'fix the login page',
        'npm ERR! code ELIFECYCLE',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'feature/login',
        'a'.repeat(40),
    ];

    function expectClean(sent: readonly Sent[]): void {
        const text = JSON.stringify(sent.map((entry) => entry.properties));
        for (const value of FORBIDDEN) {
            expect(text).not.toContain(value);
        }
    }

    describe('the pure mappings', () => {
        it('buckets a duration as plan §9.1 lists (<5, 5–15, 15–30, 30–60, >60 min), as codes', () => {
            expect(appBuildDurationBucket(0)).toBe('lt5');
            expect(appBuildDurationBucket(4 * 60 + 59)).toBe('lt5');
            expect(appBuildDurationBucket(5 * 60)).toBe('5to15');
            expect(appBuildDurationBucket(15 * 60)).toBe('15to30');
            expect(appBuildDurationBucket(30 * 60)).toBe('30to60');
            expect(appBuildDurationBucket(60 * 60)).toBe('30to60');
            expect(appBuildDurationBucket(61 * 60)).toBe('gt60');
            expect(appBuildDurationBucket(null)).toBeNull();
            expect(appBuildDurationBucket(-1)).toBeNull();
            expect(appBuildDurationBucket(Number.NaN)).toBeNull();
        });

        it('maps a workflow delivery to its §9.1 path, and an unchanged one to no event', () => {
            expect(appBuildWorkflowWrittenPath('committed')).toBe('commit');
            expect(appBuildWorkflowWrittenPath('pullRequestOpened')).toBe('pullRequest');
            expect(appBuildWorkflowWrittenPath('pullRequestUpdated')).toBe('pullRequest');
            expect(appBuildWorkflowWrittenPath('editedByHand')).toBe('editedByHand');
            expect(appBuildWorkflowWrittenPath('unchanged')).toBeNull();
            expect(appBuildWorkflowWrittenPath(undefined)).toBeNull();
        });

        it('maps a registry refusal to the validation result, and a public image to none', () => {
            expect(pullTokenTelemetryResultFor('pullTokenTooBroad')).toBe('tooBroad');
            expect(pullTokenTelemetryResultFor('pullTokenCannotRead')).toBe('cannotRead');
            expect(pullTokenTelemetryResultFor('pullTokenFineGrained')).toBe('cannotRead');
            expect(pullTokenTelemetryResultFor('pullTokenPublicImage')).toBeNull();
        });
    });

    describe('AppBuildsTelemetry', () => {
        it('sends codes, counters and flags with the user as the distinct id', () => {
            const target = sink();
            const telemetry = new AppBuildsTelemetry(target);

            telemetry.track(APP_BUILD_TELEMETRY_EVENTS.rebuildRequested, { deduped: true }, 'u1');

            expect(target.sent).toEqual([
                {
                    distinctId: 'u1',
                    event: 'app_build_rebuild_requested',
                    properties: { deduped: true },
                },
            ]);
        });

        it('drops a value that is not a code even if a caller passes one (the sanitizer backstop)', () => {
            const target = sink();
            const telemetry = new AppBuildsTelemetry(target);
            telemetry.track(APP_BUILD_TELEMETRY_EVENTS.blocked, {
                reason: 'acme/secret-widgets: fix the login page' as never,
            });
            expect(target.sent[0].properties).toEqual({});
            expect(telemetry.stats().redacted).toBe(1);
        });

        it('counts and drops when no sink is bound, and never throws', () => {
            const telemetry = new AppBuildsTelemetry(undefined);
            expect(() =>
                telemetry.track(APP_BUILD_TELEMETRY_EVENTS.dispatchFallback, { job: 'prepare' }),
            ).not.toThrow();
            expect(telemetry.stats()).toMatchObject({ emitted: 0, dropped: 1 });

            const throwing = new AppBuildsTelemetry({
                track: () => {
                    throw new Error('analytics down');
                },
            });
            expect(() =>
                throwing.track(APP_BUILD_TELEMETRY_EVENTS.dispatchFallback, { job: 'watch' }),
            ).not.toThrow();
            expect(throwing.stats().failed).toBe(1);
        });
    });

    describe('AppBuildsTelemetryListener — recorded and terminal off the app.build.* events', () => {
        /** The real event payload carries the branch, the commit and the Build's ids. */
        const payload = {
            workId: 'w1',
            userId: 'owner-1',
            buildId: 'b1',
            number: 7,
            status: 'failed' as const,
            trigger: 'push' as const,
            branch: 'feature/login',
            commitSha: 'a'.repeat(40),
            pullRequestNumber: null,
            deployable: false,
            notDeployableReason: null,
            imageDigest: null,
            failureClass: 'outOfMemory' as const,
            cancelReason: null,
        };

        it('emits app_build_recorded with the trigger only', () => {
            const target = sink();
            const listener = new AppBuildsTelemetryListener(new AppBuildsTelemetry(target));

            listener.onQueued({ payload: { ...payload, status: 'queued' } });

            expect(target.sent).toEqual([
                {
                    distinctId: 'owner-1',
                    event: 'app_build_recorded',
                    properties: { trigger: 'push' },
                },
            ]);
            expectClean(target.sent);
        });

        it('emits app_build_terminal with the bucket and runner class re-read from the row', async () => {
            const target = sink();
            const builds = {
                findByIdForWork: jest.fn(async () => ({
                    durationSeconds: 17 * 60,
                    runnerClass: 'github-private',
                })),
            };
            const listener = new AppBuildsTelemetryListener(
                new AppBuildsTelemetry(target),
                builds as never,
            );

            await listener.onFailed({ payload });

            expect(builds.findByIdForWork).toHaveBeenCalledWith('w1', 'b1');
            expect(target.sent).toEqual([
                {
                    distinctId: 'owner-1',
                    event: 'app_build_terminal',
                    properties: {
                        status: 'failed',
                        failureClass: 'outOfMemory',
                        durationBucket: '15to30',
                        runnerClass: 'github-private',
                    },
                },
            ]);
            expectClean(target.sent);
        });

        it('still emits when the row cannot be re-read, with the two re-read fields null', async () => {
            const target = sink();
            const listener = new AppBuildsTelemetryListener(new AppBuildsTelemetry(target), {
                findByIdForWork: async () => {
                    throw new Error('db down');
                },
            } as never);

            await listener.onCancelled({ payload: { ...payload, status: 'cancelled', failureClass: null } });

            expect(target.sent[0].properties).toEqual({
                status: 'cancelled',
                failureClass: null,
                durationBucket: null,
                runnerClass: null,
            });
        });

        it('ignores an event with no Build payload', async () => {
            const target = sink();
            const listener = new AppBuildsTelemetryListener(new AppBuildsTelemetry(target));
            listener.onQueued({} as never);
            await listener.onSucceeded(null as never);
            expect(target.sent).toEqual([]);
        });
    });

    describe('the prepare runner’s workflow and checks events', () => {
        function runnerWith(target: ReturnType<typeof sink>): AppBuildPrepareRunner {
            return new AppBuildPrepareRunner(
                {} as never,
                {} as never,
                {} as never,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                new AppBuildsTelemetry(target),
            );
        }

        /** Two checks whose names and commands must never reach the sink. */
        const checks = [
            { name: 'lint-and-test', command: 'pnpm test --ci', required: true, timeoutSeconds: 600 },
            { name: 'acme/secret-widgets', command: 'npm run e2e', required: false, timeoutSeconds: 600 },
        ];

        it('counts the checks a committed workflow carries, and names none of them', () => {
            const target = sink();
            (runnerWith(target) as unknown as {
                emitDeliveryTelemetry(result: unknown, input: unknown): void;
            }).emitDeliveryTelemetry(
                { workflow: { state: 'committed' } },
                { checks, checksOnly: false },
            );

            expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
                ['app_build_workflow_written', { path: 'commit' }],
                ['app_build_checks_written', { count: 2, advisory: 1, checksOnly: false }],
            ]);
            expectClean(target.sent);
        });

        it('emits nothing for an unchanged workflow, and no checks event for a hand-edited one', () => {
            const target = sink();
            const runner = runnerWith(target) as unknown as {
                emitDeliveryTelemetry(result: unknown, input: unknown): void;
            };
            runner.emitDeliveryTelemetry({ workflow: { state: 'unchanged' } }, { checks });
            expect(target.sent).toEqual([]);

            runner.emitDeliveryTelemetry({ workflow: { state: 'editedByHand' } }, { checks });
            expect(target.sent.map((entry) => entry.event)).toEqual(['app_build_workflow_written']);
        });
    });
});
