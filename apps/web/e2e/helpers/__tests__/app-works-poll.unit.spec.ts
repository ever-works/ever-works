/**
 * Unit spec for App Works polling (APW-13 T7, `tasks.md:122-128`).
 *
 * Four properties, each of which the live lanes depend on:
 *
 *   - **A failure event short-circuits the wait.** The first poll that sees a
 *     terminal failure event throws at once, with that event's payload in the
 *     message, instead of running to the deadline (ACCEPTANCE §0.5).
 *   - **Expiry reports the last observed state.** A red lane says what it saw —
 *     the events it did get, or the status a read answered — not only how long it
 *     waited.
 *   - **Present-without-prior-absent fails.** `expectAbsentThenPresent` exists so
 *     a change can be attributed to the step under test; an already-present value
 *     is a failed precondition.
 *   - **No fixed sleeps in the harness.** A source grep over the App Works
 *     helpers and every `flow-app-work*` spec fails on the banned Playwright page
 *     sleep, and is self-tested so it would still catch one added later.
 *
 * The clock and the sleep are injected everywhere, so the whole spec is
 * instant: no test here waits on a real timer.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import {
    APW_DEADLINES,
    APP_FAILURE_EVENTS,
    eventStep,
    expectAbsentThenPresent,
    failureEventsForStep,
    pollIntervalMs,
    waitForActivity,
    waitForLiveMarker,
    type ActivityEvent,
    type PollClock,
} from '../app-works-poll';

/** A deterministic clock: `sleep` advances it, so no test waits on real time. */
interface FakeClock {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    elapsed: () => number;
    sleeps: number[];
}

function fakeClock(): FakeClock {
    let current = 0;
    const sleeps: number[] = [];
    return {
        now: () => current,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            current += ms;
        },
        elapsed: () => current,
        sleeps,
    };
}

/** The injectable half of the clock, for spreading into an options object. */
function injected(clock: FakeClock): Pick<PollClock, 'now' | 'sleep'> {
    return { now: clock.now, sleep: clock.sleep };
}

/** Run `fn` and return the error it threw, failing the test when it does not throw. */
async function catchAsyncError(fn: () => Promise<unknown>): Promise<Error> {
    try {
        await fn();
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected the call to be refused, but it resolved');
}

/** Page N of an activity read; the last page repeats once the list is exhausted. */
interface ActivityPage {
    status?: number;
    body?: unknown;
}

/** Stub `GET /api/activity-log` with a sequence of pages. */
function stubActivity(pages: ActivityPage[]): {
    request: APIRequestContext;
    reads: () => number;
} {
    let reads = 0;
    const request = {
        get: async () => {
            const page = pages[Math.min(reads, pages.length - 1)];
            reads += 1;
            const status = page.status ?? 200;
            return {
                status: () => status,
                text: async () => (page.body === undefined ? '{}' : JSON.stringify(page.body)),
            } as unknown as APIResponse;
        },
    } as unknown as APIRequestContext;
    return { request, reads: () => reads };
}

/** One stubbed activity page: `GET /api/activity-log` returns `{ activities }`. */
function activities(...events: ActivityEvent[]): ActivityPage {
    return { body: { activities: events } };
}

/** Stub `fetch` for the `/marker` probe. */
function stubFetch(pages: Array<{ status?: number; body?: unknown }>): {
    impl: typeof fetch;
    reads: () => number;
} {
    let reads = 0;
    const impl = (async () => {
        const page = pages[Math.min(reads, pages.length - 1)];
        reads += 1;
        return {
            status: page.status ?? 200,
            text: async () => (page.body === undefined ? '{}' : JSON.stringify(page.body)),
        };
    }) as unknown as typeof fetch;
    return { impl, reads: () => reads };
}

const ACTIVITY_URL_OPTIONS = { token: 'unit-token', baseUrl: 'http://unit.test' };

describe('app-works-poll: the plan §8.6 deadline table lives in one place (T7)', () => {
    it('is exactly the nine budgets of plan §8.6', () => {
        expect(APW_DEADLINES).toEqual({
            forkReadyMs: 3 * 60_000,
            fixtureBuildMs: 6 * 60_000,
            calDiyBuildMs: 65 * 60_000,
            fixtureDeploymentMs: 3 * 60_000,
            calDiyDeploymentMs: 15 * 60_000,
            smokeMs: 2 * 60_000,
            provisionerProposalMs: 20 * 60_000,
            evolvePrMs: 15 * 60_000,
            upstreamPrStatusMs: 5 * 60_000,
        });
        expect(Object.keys(APW_DEADLINES)).toHaveLength(9);
    });

    it('polls every 5 s, and 15 s for a Build longer than 10 minutes', () => {
        // Plan §8.6: "polls every 5 s (15 s for Builds longer than 10 minutes)".
        expect(pollIntervalMs(APW_DEADLINES.forkReadyMs, 'fork')).toBe(5_000);
        expect(pollIntervalMs(APW_DEADLINES.fixtureBuildMs, 'build')).toBe(5_000);
        expect(pollIntervalMs(10 * 60_000, 'build')).toBe(5_000);
        expect(pollIntervalMs(APW_DEADLINES.calDiyBuildMs, 'build')).toBe(15_000);
        // Only a Build goes slow: a Deployment, a proposal and a plain wait keep 5 s.
        expect(pollIntervalMs(APW_DEADLINES.calDiyDeploymentMs, 'deploy')).toBe(5_000);
        expect(pollIntervalMs(APW_DEADLINES.provisionerProposalMs, 'provision')).toBe(5_000);
        expect(pollIntervalMs(APW_DEADLINES.evolvePrMs, 'change')).toBe(5_000);
        expect(pollIntervalMs(APW_DEADLINES.calDiyBuildMs)).toBe(5_000);
        expect(eventStep('app.build.succeeded')).toBe('build');
        expect(eventStep('app.upstream_pr.proposed')).toBe('upstream_pr');
    });

    it('scans the terminal failure events ACCEPTANCE §0.5 lists', () => {
        for (const event of [
            'app.build.failed',
            'app.deploy.failed',
            'app.deploy.rolled_back',
            'app.job.failed',
            'app.smoke.failed',
            'app.provision.failed',
            'app.change.failed',
            'app.upstream_pr.refused',
            'app.fork.timeout',
            'app.provision.needs_input',
        ]) {
            expect(APP_FAILURE_EVENTS, `${event} is watched`).toContain(event);
        }
        expect(failureEventsForStep('app.build').length).toBeGreaterThan(0);
        expect(
            failureEventsForStep('app.build').every((event) => event.startsWith('app.build.')),
        ).toBe(true);
        expect(failureEventsForStep('app.unknown')).toEqual(APP_FAILURE_EVENTS);
    });
});

describe('app-works-poll: waitForActivity (T7)', () => {
    it('short-circuits on a failure event and throws with its payload', async () => {
        const clock = fakeClock();
        const stub = stubActivity([
            activities(
                { action: 'app.build.queued', status: 'completed' },
                {
                    action: 'app.build.failed',
                    status: 'failed',
                    summary: 'the Build failed',
                    details: { reason: 'oom', logsUrl: 'https://logs.test/run-1' },
                },
            ),
        ]);

        const error = await catchAsyncError(() =>
            waitForActivity(stub.request, 'unit-token', 'work-1', 'app.build.succeeded', {
                deadlineMs: APW_DEADLINES.fixtureBuildMs,
                ...injected(clock),
                ...ACTIVITY_URL_OPTIONS,
            }),
        );

        expect(error.message).toContain('app.build.succeeded: step failed with app.build.failed');
        expect(error.message, 'the event payload is in the failure').toContain('"reason":"oom"');
        expect(error.message).toContain('https://logs.test/run-1');
        expect(stub.reads(), 'the poll short-circuits: one read, no deadline').toBe(1);
        expect(clock.elapsed()).toBe(0);
        expect(clock.sleeps).toEqual([]);
    });

    it('reports the last observed state when the deadline expires', async () => {
        const clock = fakeClock();
        const stub = stubActivity([
            activities({ action: 'app.build.queued' }),
            activities({ action: 'app.build.started', status: 'in_progress' }),
        ]);

        const error = await catchAsyncError(() =>
            waitForActivity(stub.request, 'unit-token', 'work-1', 'app.build.succeeded', {
                deadlineMs: APW_DEADLINES.fixtureBuildMs,
                ...injected(clock),
                ...ACTIVITY_URL_OPTIONS,
            }),
        );

        expect(error.message).toContain('deadline of 360000ms expired');
        expect(error.message, 'the last observed state is reported').toContain('app.build.started');
        expect(error.message).toContain('last observed state:');
        expect(clock.elapsed()).toBe(APW_DEADLINES.fixtureBuildMs);
        expect(clock.sleeps[0], 'a fixture Build polls every 5 s').toBe(5_000);
        expect(stub.reads()).toBeGreaterThan(1);
    });

    it('polls a long Cal.diy Build at 15 s and returns the matching event', async () => {
        const clock = fakeClock();
        const stub = stubActivity([
            activities({ action: 'app.build.started' }),
            activities({ action: 'app.build.started', status: 'in_progress' }),
            activities({ action: 'app.build.succeeded', status: 'completed' }),
        ]);

        const event = await waitForActivity(
            stub.request,
            'unit-token',
            'work-1',
            'app.build.succeeded',
            {
                deadlineMs: APW_DEADLINES.calDiyBuildMs,
                ...injected(clock),
                ...ACTIVITY_URL_OPTIONS,
            },
        );

        expect(event.action).toBe('app.build.succeeded');
        expect(event.status).toBe('completed');
        expect(clock.sleeps[0], 'a Build over 10 minutes polls every 15 s').toBe(15_000);
        expect(stub.reads()).toBe(3);
    });

    it('keeps polling through a non-200 read and reports it on expiry', async () => {
        const clock = fakeClock();
        const stub = stubActivity([{ status: 503 }, { status: 503 }]);

        const error = await catchAsyncError(() =>
            waitForActivity(stub.request, 'unit-token', 'work-1', 'app.smoke.passed', {
                deadlineMs: APW_DEADLINES.smokeMs,
                ...injected(clock),
                ...ACTIVITY_URL_OPTIONS,
            }),
        );

        expect(error.message).toContain('answered 503');
        expect(error.message).toContain('deadline of 120000ms expired');
        expect(stub.reads()).toBeGreaterThan(1);
    });

    it('honours a narrowed failOn list', async () => {
        const clock = fakeClock();
        const stub = stubActivity([activities({ action: 'app.build.failed' })]);

        const error = await catchAsyncError(() =>
            waitForActivity(stub.request, 'unit-token', 'work-1', 'app.smoke.passed', {
                deadlineMs: APW_DEADLINES.smokeMs,
                failOn: ['app.smoke.failed'],
                ...injected(clock),
                ...ACTIVITY_URL_OPTIONS,
            }),
        );

        // `app.build.failed` is not on the narrowed list, so the wait reaches its
        // deadline instead of short-circuiting — and still reports what it saw.
        expect(error.message).toContain('deadline of 120000ms expired');
        expect(error.message).toContain('app.build.failed');
        expect(error.message).not.toContain('step failed with');
    });
});

describe('app-works-poll: waitForLiveMarker (T7)', () => {
    it('waits for the prompted marker and the Build commit together', async () => {
        const clock = fakeClock();
        const pages = stubFetch([
            { status: 404, body: 'no such app' },
            { status: 200, body: { marker: 'run-1-greeting', sha: 'oldsha' } },
            { status: 200, body: { marker: 'run-1-greeting', sha: 'deadbeef', buildLabel: 'b1' } },
        ]);

        const body = await waitForLiveMarker(
            'https://fixture-1.apps.test',
            'run-1-greeting',
            'deadbeef',
            APW_DEADLINES.fixtureDeploymentMs,
            { ...injected(clock), fetchImpl: pages.impl },
        );

        expect(body.sha).toBe('deadbeef');
        expect(body.buildLabel).toBe('b1');
        expect(pages.reads(), 'the stale sha does not satisfy the wait').toBe(3);
    });

    it('reports the last observed marker body on expiry', async () => {
        const clock = fakeClock();
        const pages = stubFetch([
            { status: 200, body: { marker: 'run-1-greeting', sha: 'oldsha' } },
        ]);

        const error = await catchAsyncError(() =>
            waitForLiveMarker('https://fixture-1.apps.test', 'run-1-greeting', 'deadbeef', 60_000, {
                ...injected(clock),
                fetchImpl: pages.impl,
            }),
        );

        expect(error.message).toContain('deadline of 60000ms expired');
        expect(error.message, 'the last observed body is reported').toContain('"sha":"oldsha"');
        expect(error.message).toContain('/marker');
        expect(clock.elapsed()).toBe(60_000);
    });
});

describe('app-works-poll: expectAbsentThenPresent (T7)', () => {
    it('fails when the value was never observed absent', async () => {
        const clock = fakeClock();
        let probes = 0;

        const error = await catchAsyncError(() =>
            expectAbsentThenPresent(
                async () => {
                    probes += 1;
                    return 'already-here';
                },
                {
                    deadlineMs: APW_DEADLINES.evolvePrMs,
                    label: 'greeting marker',
                    isPresent: (value) => value === 'already-here',
                    ...injected(clock),
                },
            ),
        );

        expect(error.message).toContain('greeting marker');
        expect(error.message).toContain('present on the first observation');
        expect(error.message).toContain('last observed state: already-here');
        expect(probes, 'the precondition fails on the first probe').toBe(1);
        expect(clock.sleeps).toEqual([]);
    });

    it('returns the value once it appears after an absent observation', async () => {
        const clock = fakeClock();
        const observations = ['absent', 'absent', 'present'];
        let probes = 0;

        const value = await expectAbsentThenPresent(
            async () => observations[Math.min(probes++, observations.length - 1)],
            {
                deadlineMs: APW_DEADLINES.evolvePrMs,
                isPresent: (observed) => observed === 'present',
                ...injected(clock),
            },
        );

        expect(value).toBe('present');
        expect(probes).toBe(3);
        expect(clock.sleeps).toEqual([5_000, 5_000]);
    });

    it('reports the last observed state when the value never appears', async () => {
        const clock = fakeClock();

        const error = await catchAsyncError(() =>
            expectAbsentThenPresent(async () => ({ marker: 'absent' }), {
                deadlineMs: APW_DEADLINES.upstreamPrStatusMs,
                isPresent: (observed: { marker: string }) => observed.marker === 'present',
                ...injected(clock),
            }),
        );

        expect(error.message).toContain('deadline of 300000ms expired');
        expect(error.message).toContain('last observed state: {"marker":"absent"}');
    });
});

describe('app-works-poll: no fixed page sleeps in the harness (T7, ACCEPTANCE §0.5)', () => {
    /**
     * The banned call, assembled from fragments so this scanner does not flag
     * itself if the scan scope is ever widened to include `__tests__/`.
     */
    const BANNED_CALL = ['waitFor', 'Timeout'].join('');

    /** The App Works harness helpers of plan §8.2, by file name. */
    const HARNESS_HELPERS = [
        'app-works.ts',
        'app-works-poll.ts',
        'app-works-live.ts',
        'app-works-evidence.ts',
        'github-estate.ts',
        'github-connection.ts',
        'k8s-assert.ts',
        'canary-sink.ts',
    ];

    /** Walk up from the cwd to `apps/web/e2e`, so the spec runs from anywhere. */
    function resolveE2eRoot(): string {
        let dir = process.cwd();
        for (;;) {
            for (const candidate of [resolve(dir, 'e2e'), resolve(dir, 'apps/web/e2e')]) {
                if (existsSync(resolve(candidate, 'helpers'))) return candidate;
            }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        throw new Error(`could not locate apps/web/e2e above ${process.cwd()}`);
    }

    /** Every regular file under `dir`, recursively. */
    function listFiles(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) listFiles(full, out);
            else out.push(full);
        }
        return out;
    }

    /** The files whose source must not contain the banned call. */
    function scannedFiles(): string[] {
        const e2e = resolveE2eRoot();
        const helpers = HARNESS_HELPERS.map((name) => join(e2e, 'helpers', name)).filter((file) =>
            existsSync(file),
        );
        // Every flow-app-work* spec (and any flow-app-work* helper) the epic adds,
        // found by glob rather than by name, so a spec added later is scanned
        // without touching this list.
        const flowAppWork = listFiles(e2e).filter((file) =>
            /(^|[\\/])flow-app-work[^\\/]*\.ts$/.test(file),
        );
        return [...helpers, ...flowAppWork];
    }

    it('scans the App Works helpers and every flow-app-work* file', () => {
        const files = scannedFiles();
        expect(files.length, 'the scan is not vacuous').toBeGreaterThan(0);
        expect(
            files.some((file) => file.endsWith(`app-works-poll.ts`)),
            'the polling helper itself is in scope',
        ).toBe(true);
        // A `flow-app-work*` spec may not exist yet (the P0 harness ships first);
        // the glob above still has to find one as soon as it does.
        const flowFiles = files.filter((file) => file.includes('flow-app-work'));
        for (const file of flowFiles) {
            expect(file.endsWith('.ts'), `${file} is a TypeScript spec`).toBe(true);
        }
    });

    it('finds no fixed page sleep in any scanned file', () => {
        const offenders = scannedFiles()
            .filter((file) => readFileSync(file, 'utf8').includes(BANNED_CALL))
            .map((file) => file.replace(`${resolveE2eRoot()}${sep}`, ''));
        expect(offenders, `no helper or flow-app-work* spec may call ${BANNED_CALL}`).toEqual([]);
    });

    it('is written so it would catch a fixed page sleep added later', () => {
        const synthetic = `await page.${BANNED_CALL}(1_500);`;
        expect(synthetic.includes(BANNED_CALL), 'the scanner matches the banned call').toBe(true);
        expect(`await expect.poll(fn).toBe(true)`.includes(BANNED_CALL)).toBe(false);
    });
});
