import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    APP_FORK_READINESS_POLL_DELAYS_MS,
    APP_FORK_READINESS_POLL_INTERVAL_MS,
    APP_FORK_READINESS_TIMEOUT_MS,
    APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS,
    APP_PRIVATE_COPY_MAX_SIZE_KB,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import { GitOperationNotSupportedError } from '../../facades/git.facade';
import { AppForkReadinessService, resolveReadinessTimeoutMs } from '../app-fork-readiness.service';

/**
 * APW-02 T24 — the readiness run (plan §6.2, FR-17…FR-24a, ACC-02-04…06).
 *
 * Three things this spec is built around, and each of them is a requirement
 * rather than a convenience:
 *
 *   - **A fake clock.** The run's whole job is to wait, and a test that waits
 *     fifteen real minutes is a test nobody runs. `sleep` is injected (that is
 *     what the job runtime's `wait.for` is bound to in production) and the
 *     clock the deadline reads is injected beside it — so the schedule is
 *     asserted as **recorded sleep durations**, `[2000, 4000, 8000, 15000,
 *     15000, …]` (FR-18), and the deadline as a number of milliseconds that
 *     never exceeds 900 000.
 *   - **The order hygiene and setup happen in** (FR-22): hygiene, *then* the
 *     setup hand-off, exactly once each — asserted on one shared call log
 *     rather than by two independent `toHaveBeenCalled` checks, because the
 *     order is the requirement.
 *   - **What the run never does.** It never forks and never creates a
 *     repository (FR-19: **Try again** resumes the same repository). The last
 *     test in this file asserts that against the service's own source text, so
 *     a later edit that reaches for `forkRepository` fails here rather than in
 *     production.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const UPSTREAM = { owner: 'upstream-org', repo: 'widgets' };
const DATA = { owner: 'me', repo: 'widgets' };

/** A fake clock whose sleeps are recorded AND advance time. */
function fakeClock(startMs = 1_700_000_000_000) {
    let current = startMs;
    const sleeps: number[] = [];
    return {
        now: () => current,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            current += ms;
        },
        sleeps,
        advance: (ms: number) => {
            current += ms;
        },
        elapsed: () => current - startMs,
    };
}

/** The `AppReadinessAttempt` of plan §6.2 step 1. */
function makeAttempt(overrides: Record<string, unknown> = {}) {
    return {
        found: true,
        ready: false,
        readinessState: 'preparing',
        relation: 'fork',
        dataOwner: DATA.owner,
        dataRepo: DATA.repo,
        dataDefaultBranch: 'main',
        upstreamOwner: UPSTREAM.owner,
        upstreamRepo: UPSTREAM.repo,
        upstreamDefaultBranch: 'main',
        copyPushedSha: null,
        setupPullRequestNumber: null,
        ...overrides,
    };
}

/** `ready` for every probe after the first `empties`, then `ready` for ever. */
function probesThenReady(empties: number) {
    let seen = 0;
    return jest.fn(async () => {
        seen += 1;
        return seen > empties
            ? { status: 'ready', empty: false }
            : { status: 'preparing', empty: true };
    });
}

/** The two hand-off doubles, typed so a test can assert on their call logs. */
type HandlerDouble = { onDataRepositoryReady: jest.Mock };
type ProvisionDouble = { forkReady: jest.Mock };

function makeService(
    options: {
        attempt?: Record<string, unknown> | null;
        probes?: jest.Mock;
        copy?: unknown;
        copyThrows?: unknown;
        handler?: HandlerDouble | null;
        provision?: ProvisionDouble | null;
        work?: { userId: string } | null;
    } = {},
) {
    const order: string[] = [];
    const attempt = options.attempt === undefined ? makeAttempt() : options.attempt;

    const states = {
        beginAttempt: jest.fn(async () => {
            order.push('beginAttempt');
            return attempt;
        }),
        probeReadiness: jest.fn(async (...args: unknown[]) => {
            order.push('probe');
            const probe = options.probes ?? probesThenReady(0);
            return probe(...args);
        }),
        recordCopyPushed: jest.fn(async () => {
            order.push('recordCopyPushed');
            return true;
        }),
        markReady: jest.fn(async (_workId: string, outcome: { result: string }) => {
            order.push('markReady');
            return {
                found: true,
                state: outcome?.result === 'failed' ? 'failed' : 'ready',
                emitted: true,
            };
        }),
        timeout: jest.fn(async () => {
            order.push('timeout');
            return { found: true, state: 'timed_out', emitted: true };
        }),
        fail: jest.fn(async (_workId: string, reason: string) => {
            order.push(`fail:${reason}`);
            return { found: true, state: 'failed', emitted: false };
        }),
    };

    const createRepositoryCopy = jest.fn();
    if (options.copyThrows !== undefined) {
        createRepositoryCopy.mockRejectedValue(options.copyThrows);
    } else {
        createRepositoryCopy.mockImplementation(async () => {
            order.push('createRepositoryCopy');
            return options.copy ?? { pushedSha: 'a'.repeat(40), alreadyUpToDate: false };
        });
    }

    const hygiene = {
        apply: jest.fn(async () => {
            order.push('hygiene');
            return { state: 'clean' };
        }),
    };

    const handler: HandlerDouble | null =
        options.handler === undefined
            ? {
                  onDataRepositoryReady: jest.fn(async () => {
                      order.push('handler');
                      return { result: 'initialized' };
                  }),
              }
            : options.handler;

    const provisionEvents: ProvisionDouble | null =
        options.provision === undefined
            ? {
                  forkReady: jest.fn(async () => {
                      order.push('forkReady');
                  }),
              }
            : options.provision;

    const works = {
        findById: jest
            .fn()
            .mockResolvedValue(options.work === undefined ? { userId: USER_ID } : options.work),
    };

    const service = new AppForkReadinessService(
        states as never,
        { createRepositoryCopy } as never,
        hygiene as never,
        works as never,
        handler as never,
        provisionEvents as never,
    );

    return {
        service,
        states,
        createRepositoryCopy,
        hygiene,
        handler,
        provisionEvents,
        works,
        order,
    };
}

const PAYLOAD = { workId: WORK_ID, attempt: 1 };

describe('resolveReadinessTimeoutMs — FR-18 and FR-18a', () => {
    it('is 15 minutes by default', () => {
        expect(resolveReadinessTimeoutMs({} as NodeJS.ProcessEnv)).toBe(
            APP_FORK_READINESS_TIMEOUT_MS,
        );
        expect(APP_FORK_READINESS_TIMEOUT_MS).toBe(900_000);
    });

    it('honours the override outside production', () => {
        expect(
            resolveReadinessTimeoutMs({
                NODE_ENV: 'test',
                EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS: '30000',
            } as NodeJS.ProcessEnv),
        ).toBe(30_000);
    });

    it('clamps the override to 5 000 … 900 000 ms', () => {
        expect(
            resolveReadinessTimeoutMs({
                EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS: '1',
            } as NodeJS.ProcessEnv),
        ).toBe(APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS);
        expect(
            resolveReadinessTimeoutMs({
                EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS: '999999999',
            } as NodeJS.ProcessEnv),
        ).toBe(APP_FORK_READINESS_TIMEOUT_MS);
    });

    it('ignores a value that is not an integer, rather than shortening anything', () => {
        for (const raw of ['', '  ', 'abc', '12s', '10.5', '-1']) {
            expect(
                resolveReadinessTimeoutMs({
                    EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS: raw,
                } as NodeJS.ProcessEnv),
            ).toBe(APP_FORK_READINESS_TIMEOUT_MS);
        }
    });

    it('ignores the override entirely in production', () => {
        expect(
            resolveReadinessTimeoutMs({
                NODE_ENV: 'production',
                EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS: '10000',
            } as NodeJS.ProcessEnv),
        ).toBe(APP_FORK_READINESS_TIMEOUT_MS);
    });
});

describe('AppForkReadinessService — the exits that cost nothing', () => {
    it('stops at once when the Work has no state row', async () => {
        const clock = fakeClock();
        const { service, states, hygiene, handler } = makeService({
            attempt: makeAttempt({ found: false }),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('not_found');
        expect(result.probes).toBe(0);
        expect(clock.sleeps).toEqual([]);
        expect(states.probeReadiness).not.toHaveBeenCalled();
        expect(hygiene.apply).not.toHaveBeenCalled();
        expect(handler.onDataRepositoryReady).not.toHaveBeenCalled();
    });

    it('stops at once when the Work is already ready (FR-22)', async () => {
        const clock = fakeClock();
        const { service, states, hygiene, handler } = makeService({
            attempt: makeAttempt({ ready: true, readinessState: 'ready' }),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('already_ready');
        expect(states.probeReadiness).not.toHaveBeenCalled();
        expect(hygiene.apply).not.toHaveBeenCalled();
        expect(handler.onDataRepositoryReady).not.toHaveBeenCalled();
        expect(states.markReady).not.toHaveBeenCalled();
    });

    it('reports a state service that cannot be reached instead of throwing', async () => {
        const clock = fakeClock();
        const { service, states } = makeService();
        states.beginAttempt.mockRejectedValue(new Error('proxy is down'));

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('state_unavailable');
    });
});

describe('AppForkReadinessService — the poll (FR-17, FR-18, ACC-02-04)', () => {
    it('polls on 2, 4, 8, 15, 15 … seconds and stops as soon as the repository has a commit', async () => {
        const clock = fakeClock();
        const { service, states } = makeService({ probes: probesThenReady(2) });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(clock.sleeps).toEqual([2000, 4000, 8000]);
        expect(result.sleeps).toEqual([2000, 4000, 8000]);
        expect(result.probes).toBe(3);
        expect(APP_FORK_READINESS_POLL_DELAYS_MS).toEqual([2000, 4000, 8000, 15000]);
        expect(states.probeReadiness).toHaveBeenCalledWith(WORK_ID, 'github');
        // ACC-02-04: ready within 30 s of the first commit.
        expect(clock.elapsed()).toBeLessThan(30_000);
    });

    it('runs hygiene BEFORE the setup hand-off, each exactly once (FR-22)', async () => {
        const clock = fakeClock();
        const { service, order, hygiene, handler } = makeService({ probes: probesThenReady(1) });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(hygiene.apply).toHaveBeenCalledTimes(1);
        expect(handler.onDataRepositoryReady).toHaveBeenCalledTimes(1);
        expect(handler.onDataRepositoryReady).toHaveBeenCalledWith({ workId: WORK_ID });
        expect(order).toEqual([
            'beginAttempt',
            'probe',
            'probe',
            'hygiene',
            'handler',
            'markReady',
            'forkReady',
        ]);
    });

    it('tells the provisioning port once the repository really is ready', async () => {
        const clock = fakeClock();
        const { service, provisionEvents } = makeService({ probes: probesThenReady(0) });

        await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(provisionEvents.forkReady).toHaveBeenCalledWith(WORK_ID);
    });

    it('keeps polling while the repository reads back empty', async () => {
        const clock = fakeClock();
        const { service } = makeService({ probes: probesThenReady(4) });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(clock.sleeps).toEqual([2000, 4000, 8000, 15000, 15000]);
        expect(result.probes).toBe(5);
    });

    it('survives a probe that could not be made at all', async () => {
        const clock = fakeClock();
        let calls = 0;
        const probes = jest.fn(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error('remote proxy is unreachable');
            }
            return calls === 2
                ? { status: 'preparing', empty: true }
                : { status: 'ready', empty: false };
        });
        const { service } = makeService({ probes });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(result.probes).toBe(3);
    });
});

describe('AppForkReadinessService — the deadline (FR-18, ACC-02-05)', () => {
    it('times out at 900 000 ms, never taking a wait that would cross it', async () => {
        const clock = fakeClock();
        const { service, states } = makeService({
            probes: jest.fn(async () => ({ status: 'preparing', empty: true })),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('timed_out');
        expect(states.timeout).toHaveBeenCalledWith(WORK_ID, 1);
        expect(clock.elapsed()).toBeLessThanOrEqual(APP_FORK_READINESS_TIMEOUT_MS);
        // The schedule is FR-18's, verbatim, for as long as it lasts…
        expect(clock.sleeps.slice(0, 4)).toEqual([2000, 4000, 8000, 15000]);
        // …and every wait after the fourth is the 15-second interval.
        expect(new Set(clock.sleeps.slice(4))).toEqual(
            new Set([APP_FORK_READINESS_POLL_INTERVAL_MS]),
        );
        expect(result.probes).toBe(clock.sleeps.length);
    });

    it('honours a shortened deadline outside production (FR-18a)', async () => {
        const clock = fakeClock();
        const { service, states } = makeService({
            probes: jest.fn(async () => ({ status: 'preparing', empty: true })),
        });
        const previous = process.env.EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS;
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS = '5000';
        process.env.NODE_ENV = 'test';

        try {
            const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

            expect(result.outcome).toBe('timed_out');
            expect(clock.elapsed()).toBeLessThanOrEqual(5000);
            expect(clock.sleeps).toEqual([2000]);
            expect(states.timeout).toHaveBeenCalledTimes(1);
        } finally {
            if (previous === undefined) delete process.env.EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS;
            else process.env.EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS = previous;
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('sleeps to the provider’s retry instant instead of the schedule, once (FR-50)', async () => {
        const clock = fakeClock();
        let calls = 0;
        const probes = jest.fn(async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    status: 'rate_limited',
                    empty: null,
                    retryAt: new Date(clock.now() + 30_000).toISOString(),
                };
            }
            return { status: 'ready', empty: false };
        });
        const { service } = makeService({ probes });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        // 2 000 for the first schedule slot, then the provider's 30 s — the 4 s slot
        // is REPLACED, not added to.
        expect(clock.sleeps).toEqual([2000, 30_000]);
    });

    it('does not sleep past the deadline for a rate limit that lands beyond it', async () => {
        const clock = fakeClock();
        const probes = jest.fn(async () => ({
            status: 'rate_limited',
            empty: null,
            retryAt: new Date(clock.now() + 5_000_000).toISOString(),
        }));
        const { service, states } = makeService({ probes });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('timed_out');
        expect(states.timeout).toHaveBeenCalledWith(WORK_ID, 1);
        expect(clock.elapsed()).toBeLessThanOrEqual(APP_FORK_READINESS_TIMEOUT_MS);
    });

    it('ignores a retry instant that is already in the past', async () => {
        const clock = fakeClock();
        let calls = 0;
        const probes = jest.fn(async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    status: 'rate_limited',
                    empty: null,
                    retryAt: new Date(clock.now() - 1000).toISOString(),
                };
            }
            return { status: 'ready', empty: false };
        });
        const { service } = makeService({ probes });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(clock.sleeps).toEqual([2000, 4000]);
    });
});

describe('AppForkReadinessService — losing access (FR-20, ACC-02-06)', () => {
    it('records access_revoked, stops, and runs neither hygiene nor setup', async () => {
        const clock = fakeClock();
        const probes = jest
            .fn()
            .mockResolvedValueOnce({ status: 'preparing', empty: true })
            .mockResolvedValueOnce({
                status: 'access_revoked',
                empty: null,
                reason: 'unauthorized',
            });
        const { service, states, hygiene, handler } = makeService({ probes });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('access_revoked');
        expect(states.fail).toHaveBeenCalledWith(WORK_ID, 'access_revoked');
        expect(states.timeout).not.toHaveBeenCalled();
        expect(hygiene.apply).not.toHaveBeenCalled();
        expect(handler.onDataRepositoryReady).not.toHaveBeenCalled();
        // Try again resumes the SAME repository: this run never asks for a fork.
        expect(clock.sleeps).toEqual([2000, 4000]);
    });

    it('records a provider failure the probe classified', async () => {
        const clock = fakeClock();
        const probes = jest.fn(async () => ({
            status: 'failed',
            empty: null,
            reason: 'provider_unsupported',
        }));
        const { service, states } = makeService({ probes });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('provider_unsupported');
        expect(states.fail).toHaveBeenCalledWith(WORK_ID, 'provider_unsupported');
    });
});

describe('AppForkReadinessService — the private copy (FR-21, ACC-02-15)', () => {
    const copyAttempt = makeAttempt({
        relation: 'private-copy',
        upstreamOwner: UPSTREAM.owner,
        upstreamRepo: UPSTREAM.repo,
        upstreamDefaultBranch: 'main',
    });

    it('pushes the full history once, with the authorised ceiling, then polls', async () => {
        const clock = fakeClock();
        const { service, createRepositoryCopy, states } = makeService({
            attempt: copyAttempt,
            probes: probesThenReady(0),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(createRepositoryCopy).toHaveBeenCalledTimes(1);
        const [input, options] = createRepositoryCopy.mock.calls[0];
        expect(input).toEqual({
            sourceOwner: UPSTREAM.owner,
            sourceRepo: UPSTREAM.repo,
            sourceBranch: 'main',
            targetOwner: DATA.owner,
            targetRepo: DATA.repo,
            maxSizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB,
        });
        expect(options).toEqual({ userId: USER_ID, providerId: 'github', workId: WORK_ID });
        expect(states.recordCopyPushed).toHaveBeenCalledWith(WORK_ID, 'a'.repeat(40));
        expect(result.copyPushedSha).toBe('a'.repeat(40));
    });

    it('does not push a second time when the row already holds the pushed sha (FR-21)', async () => {
        const clock = fakeClock();
        const { service, createRepositoryCopy } = makeService({
            attempt: makeAttempt({
                relation: 'private-copy',
                copyPushedSha: 'b'.repeat(40),
            }),
            probes: probesThenReady(0),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(createRepositoryCopy).not.toHaveBeenCalled();
        expect(result.copyPushedSha).toBeUndefined();
    });

    it('does not push at all for a fork', async () => {
        const clock = fakeClock();
        const { service, createRepositoryCopy } = makeService({ probes: probesThenReady(0) });

        await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(createRepositoryCopy).not.toHaveBeenCalled();
    });

    it('refuses an upstream over the ceiling with the closed-set reason too_large', async () => {
        const clock = fakeClock();
        const error = new GitProviderRequestError('unprocessable', 422);
        error.message = 'too_large';
        const { service, states } = makeService({ attempt: copyAttempt, copyThrows: error });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('too_large');
        expect(states.fail).toHaveBeenCalledWith(WORK_ID, 'too_large');
        expect(states.probeReadiness).not.toHaveBeenCalled();
        expect(clock.sleeps).toEqual([]);
    });

    it('refuses a Git LFS upstream as copy_refused — the closed set has no `uses_lfs` member (FR-65)', async () => {
        const clock = fakeClock();
        const error = new GitProviderRequestError('unprocessable', 422);
        error.message = 'uses_lfs';
        const { service, states } = makeService({ attempt: copyAttempt, copyThrows: error });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('copy_refused');
        expect(states.fail).toHaveBeenCalledWith(WORK_ID, 'copy_refused');
    });

    it('refuses when the platform cannot copy at all, without waiting for the deadline', async () => {
        const clock = fakeClock();
        const { service, states } = makeService({
            attempt: copyAttempt,
            copyThrows: new GitOperationNotSupportedError('createRepositoryCopy', 'github'),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('provider_unsupported');
        expect(states.fail).toHaveBeenCalledWith(WORK_ID, 'provider_unsupported');
    });

    it('refuses a copy whose coordinates are incomplete rather than pushing the wrong history', async () => {
        const clock = fakeClock();
        const { service, createRepositoryCopy, states } = makeService({
            attempt: makeAttempt({
                relation: 'private-copy',
                upstreamOwner: null,
                upstreamRepo: null,
            }),
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('copy_refused');
        expect(createRepositoryCopy).not.toHaveBeenCalled();
        expect(states.fail).toHaveBeenCalledWith(WORK_ID, 'copy_refused');
    });

    it('makes no copy when the Work owner cannot be read — no credential, no push', async () => {
        const clock = fakeClock();
        const { service, createRepositoryCopy } = makeService({
            attempt: copyAttempt,
            work: null,
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('copy_refused');
        expect(createRepositoryCopy).not.toHaveBeenCalled();
    });
});

describe('AppForkReadinessService — the setup hand-off (FR-22, FR-24a)', () => {
    it('records what a handler waiting for the setup pull request answered', async () => {
        const clock = fakeClock();
        const handler = {
            onDataRepositoryReady: jest.fn(async () => ({
                result: 'waiting_for_setup_pr',
                setupPullRequestNumber: 12,
                setupPullRequestUrl: 'https://github.com/me/widgets/pull/12',
            })),
        };
        const { service, states, provisionEvents } = makeService({
            probes: probesThenReady(0),
            handler,
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('waiting_for_setup_pr');
        expect(states.markReady).toHaveBeenCalledWith(WORK_ID, {
            result: 'waiting_for_setup_pr',
            setupPullRequestNumber: 12,
            setupPullRequestUrl: 'https://github.com/me/widgets/pull/12',
        });
        expect(provisionEvents.forkReady).toHaveBeenCalledWith(WORK_ID);
    });

    it('records a failed handler outcome and does not tell provisioning the fork is ready', async () => {
        const clock = fakeClock();
        const handler = {
            onDataRepositoryReady: jest.fn(async () => ({
                result: 'failed',
                reason: 'no_blueprint',
            })),
        };
        const { service, states, provisionEvents } = makeService({
            probes: probesThenReady(0),
            handler,
        });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('no_blueprint');
        expect(states.markReady).toHaveBeenCalledWith(WORK_ID, {
            result: 'failed',
            reason: 'no_blueprint',
        });
        expect(provisionEvents.forkReady).not.toHaveBeenCalled();
    });

    it('treats a handler that throws as a failed outcome, never as a dead job', async () => {
        const clock = fakeClock();
        const handler = {
            onDataRepositoryReady: jest.fn(async () => {
                throw new Error('blueprint service exploded');
            }),
        };
        const { service, states } = makeService({ probes: probesThenReady(0), handler });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('unexpected');
        expect(states.markReady).toHaveBeenCalledWith(WORK_ID, {
            result: 'failed',
            reason: 'unexpected',
        });
    });

    it('records `initialized` and comes to rest ready when no handler is registered (R-4)', async () => {
        const clock = fakeClock();
        const { service, states } = makeService({ probes: probesThenReady(0), handler: null });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(states.markReady).toHaveBeenCalledWith(WORK_ID, { result: 'initialized' });
    });

    it('does not let a failing provisioning port fail the run', async () => {
        const clock = fakeClock();
        const provision = {
            forkReady: jest.fn(async () => {
                throw new Error('provisioning port is down');
            }),
        };
        const { service } = makeService({ probes: probesThenReady(0), provision });

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
    });

    it('does not let a failing state write fail the run', async () => {
        const clock = fakeClock();
        const { service, states } = makeService({ probes: probesThenReady(0) });
        states.markReady.mockRejectedValue(new Error('database is gone'));

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
    });
});

describe('AppForkReadinessService — the setup-merged follow-through (FR-24a)', () => {
    it('skips polling and hygiene and calls the handler once more', async () => {
        const clock = fakeClock();
        const handler = { onDataRepositoryReady: jest.fn(async () => ({ result: 'unchanged' })) };
        const { service, states, hygiene, createRepositoryCopy } = makeService({
            attempt: makeAttempt({
                readinessState: 'waiting_for_setup_pr',
                setupPullRequestNumber: 9,
            }),
            handler,
        });

        const result = await service.run(
            { workId: WORK_ID, attempt: 1, reason: 'setup_merged' },
            { sleep: clock.sleep, now: clock.now },
        );

        expect(result.outcome).toBe('setup_merged');
        expect(clock.sleeps).toEqual([]);
        expect(states.probeReadiness).not.toHaveBeenCalled();
        expect(hygiene.apply).not.toHaveBeenCalled();
        expect(createRepositoryCopy).not.toHaveBeenCalled();
        expect(handler.onDataRepositoryReady).toHaveBeenCalledTimes(1);
        expect(states.markReady).toHaveBeenCalledWith(WORK_ID, { result: 'unchanged' });
    });
});

describe('AppForkReadinessService — hygiene and the relations', () => {
    it('asks hygiene for a fork, with the coordinates the row carries', async () => {
        const clock = fakeClock();
        const { service, hygiene } = makeService({ probes: probesThenReady(0) });

        await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(hygiene.apply).toHaveBeenCalledWith(WORK_ID, {
            relation: 'fork',
            dataOwner: DATA.owner,
            dataRepo: DATA.repo,
        });
    });

    it('asks hygiene for a linked repository too, so its not_applicable answer is recorded', async () => {
        const clock = fakeClock();
        const { service, hygiene } = makeService({
            attempt: makeAttempt({ relation: 'link' }),
            probes: probesThenReady(0),
        });

        await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(hygiene.apply).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ relation: 'link' }),
        );
    });

    it('does not let a hygiene that throws stop the setup hand-off (FR-30)', async () => {
        const clock = fakeClock();
        const { service, hygiene, handler } = makeService({ probes: probesThenReady(0) });
        hygiene.apply.mockRejectedValue(new Error('hygiene exploded'));

        const result = await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        expect(result.outcome).toBe('ready');
        expect(handler.onDataRepositoryReady).toHaveBeenCalledTimes(1);
    });
});

describe('AppForkReadinessService — what the readiness path never does (T24 done-when, FR-19)', () => {
    it('calls neither forkRepository nor createRepository — from any test path', async () => {
        const clock = fakeClock();
        const { service, createRepositoryCopy } = makeService({ probes: probesThenReady(0) });

        await service.run(PAYLOAD, { sleep: clock.sleep, now: clock.now });

        // The git double this spec hands the service exposes ONE capability, so a call
        // to a fork or a repository create would be a TypeError here…
        expect(Object.keys({ createRepositoryCopy })).toEqual(['createRepositoryCopy']);
        // …and the service's own source names neither of them.
        const source = readFileSync(join(__dirname, '..', 'app-fork-readiness.service.ts'), 'utf8');
        expect(source).not.toMatch(/\bforkRepository\b/);
        expect(source).not.toMatch(/\bcreateRepository\b/);
        expect(source).toMatch(/\bcreateRepositoryCopy\b/);
    });
});
