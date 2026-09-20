import {
    APP_RATE_LIMIT_BACKOFF_MAX_MS,
    APP_RATE_LIMIT_RESET_GRACE_MS,
    APP_UPSTREAM_SYNC_BRANCH,
    APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE,
    APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS,
} from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import { GitOperationNotSupportedError } from '../../facades/git.facade';
import {
    AppUpstreamSyncService,
    ProviderBudgetExceededError,
    ProviderCallBudget,
    type AppUpstreamSyncDeps,
    type AppUpstreamSyncRunResult,
} from '../app-upstream-sync.service';
import { computeNextUpstreamSync, upstreamSyncJitterMs } from '../upstream-schedule';

/**
 * APW-02 T26 — the sync run (plan §6.3, `plan.md:715-754`; spec FR-32…FR-62,
 * ACC-02-09…ACC-02-19).
 *
 * The claims this spec exists to pin, in the order the task text makes them:
 *
 *   1. **The claim is taken through the state service, never through a distributed
 *      lock** — `beginSync` decides, and **every path that claimed ends in
 *      `finishSync`**, which is what releases it. A refused claim settles nothing.
 *   2. **Nothing is ever pushed to the upstream and no write is ever forced**
 *      (FR-39) — every test runs through {@link runSync}, which scans the provider
 *      double's recorded calls for exactly those two things.
 *   3. **The four pause states, the rename, the two licence paths, the two
 *      pull-request paths, the race, the rewritten history, the closed pull
 *      request, the conflict and the two rate-limit shapes** all behave as §6.3
 *      writes them.
 *   4. **The budget stops the run at
 *      {@link APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS} calls** (FR-49, §9.2).
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'me';
const REPO = 'widgets';
const UPSTREAM_OWNER = 'upstream';
const UPSTREAM_REPO = 'project';
const TRACKED_BRANCH = 'main';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

/** A Monday, 00:00 UTC — the default schedule's own day. */
const NOW = Date.parse('2026-01-05T00:00:00.000Z');

const JITTER = upstreamSyncJitterMs(WORK_ID);

/** A state row as `WorkUpstreamStateRepository.findByWorkId` returns it. */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        workId: WORK_ID,
        relation: 'fork',
        dataOwner: OWNER,
        dataRepo: REPO,
        dataDefaultBranch: TRACKED_BRANCH,
        upstreamOwner: UPSTREAM_OWNER,
        upstreamRepo: UPSTREAM_REPO,
        upstreamDefaultBranch: TRACKED_BRANCH,
        upstreamPreviousDefaultBranch: null,
        upstreamStatus: 'available',
        upstreamCheckedAt: null,
        upstreamHeadSha: null,
        dataRepositoryStatus: 'available',
        readinessState: 'ready',
        syncSchedule: null,
        syncStartedAt: null,
        syncFinishedAt: null,
        lastSyncResult: null,
        lastSyncReason: null,
        lastSyncCommitCount: null,
        lastSyncedUpstreamSha: null,
        syncPullRequestNumber: null,
        syncPullRequestUrl: null,
        syncPullRequestClosedHeadSha: null,
        aheadBy: null,
        behindBy: null,
        divergenceComputedAt: null,
        behindEventCount: null,
        consecutiveRateLimited: 0,
        rateLimitedUntil: null,
        ...overrides,
    };
}

/** The repository object the provider double answers reads with. */
function repository(owner: string, name: string, overrides: Record<string, unknown> = {}) {
    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        defaultBranch: TRACKED_BRANCH,
        isPrivate: false,
        url: `https://github.com/${owner}/${name}`,
        cloneUrl: `https://github.com/${owner}/${name}.git`,
        ...overrides,
    };
}

/**
 * The provider double: **every** facade method the run may reach, including the
 * three it must never reach (`push`, `replaceRemote`, `mergePullRequest`), so a
 * future edit that starts writing to the upstream is caught by the scan rather
 * than by a reviewer.
 */
const PROVIDER_METHODS = [
    'getRepository',
    'getForkDivergence',
    'syncForkBranch',
    'createBranchFromSha',
    'updateBranchRef',
    'deleteBranch',
    'createPullRequest',
    'getPullRequest',
    'listPullRequests',
    'getPullRequestStatus',
    'getPullRequestFiles',
    'push',
    'replaceRemote',
    'mergePullRequest',
    'cloneOrPull',
] as const;

/** The methods that write to a repository — their first two arguments name it. */
const WRITE_METHODS = [
    'syncForkBranch',
    'createBranchFromSha',
    'updateBranchRef',
    'deleteBranch',
    'createPullRequest',
    'push',
    'replaceRemote',
    'mergePullRequest',
] as const;

type ProviderMethod = (typeof PROVIDER_METHODS)[number];
type Handler = (...args: never[]) => unknown;

interface Harness {
    service: AppUpstreamSyncService;
    states: {
        beginSync: jest.Mock;
        finishSync: jest.Mock;
        recordConflict: jest.Mock;
    };
    git: Record<ProviderMethod, jest.Mock>;
    calls: Record<ProviderMethod, unknown[][]>;
    hygiene: { apply: jest.Mock };
    rows: { findByWorkId: jest.Mock; update: jest.Mock };
    works: { findById: jest.Mock };
    activity: { log: jest.Mock };
    specs: { getEffectiveSpec: jest.Mock };
    licenses: { previewUpstream: jest.Mock; request: jest.Mock };
    privateCopies?: { compare: jest.Mock; moveSyncBranch: jest.Mock };
    sleep: jest.Mock;
}

function makeHarness(
    options: {
        row?: Record<string, unknown> | null;
        handlers?: Partial<Record<ProviderMethod, Handler>>;
        beginSync?: Record<string, unknown>;
        spec?: Record<string, unknown> | null;
        privateCopies?: boolean;
        noLicenseService?: boolean;
        noSpecSource?: boolean;
        noRowRepository?: boolean;
        noWorkRepository?: boolean;
        conflictThrows?: boolean;
    } = {},
): Harness {
    const row = options.row === undefined ? makeRow() : options.row;

    const defaultHandlers: Partial<Record<ProviderMethod, Handler>> = {
        getRepository: ((owner: string, name: string) =>
            repository(owner, name)) as unknown as Handler,
        getForkDivergence: (() => ({
            aheadBy: 0,
            behindBy: 0,
            upstreamHeadSha: SHA_B,
            forkHeadSha: SHA_A,
        })) as unknown as Handler,
        updateBranchRef: (() => ({
            name: APP_UPSTREAM_SYNC_BRANCH,
            commit: SHA_B,
            isDefault: false,
        })) as unknown as Handler,
        createBranchFromSha: (() => ({
            name: APP_UPSTREAM_SYNC_BRANCH,
            commit: SHA_B,
            isDefault: false,
        })) as unknown as Handler,
        createPullRequest: (() => ({
            number: 7,
            title: 'Sync with upstream',
            state: 'open',
            head: APP_UPSTREAM_SYNC_BRANCH,
            base: TRACKED_BRANCH,
            url: 'https://github.com/me/widgets/pull/7',
            createdAt: '',
            updatedAt: '',
        })) as unknown as Handler,
        getPullRequestStatus: (() => ({
            number: 7,
            state: 'open',
            merged: false,
            mergeable: true,
            headSha: SHA_C,
            ciState: 'unknown',
            checks: [],
        })) as unknown as Handler,
        listPullRequests: (() => []) as unknown as Handler,
        getPullRequestFiles: (() => []) as unknown as Handler,
    };

    const handlers = { ...defaultHandlers, ...(options.handlers ?? {}) };
    const calls = {} as Record<ProviderMethod, unknown[][]>;
    const git = {} as Record<ProviderMethod, jest.Mock>;

    for (const method of PROVIDER_METHODS) {
        calls[method] = [];
        git[method] = jest.fn(async (...args: unknown[]) => {
            calls[method].push(args);
            const handler = handlers[method];
            return handler ? (handler as (...a: unknown[]) => unknown)(...args) : undefined;
        });
    }

    const states = {
        beginSync: jest.fn().mockResolvedValue({
            allowed: true,
            reason: null,
            startedAt: new Date(NOW).toISOString(),
            ...(options.beginSync ?? {}),
        }),
        finishSync: jest.fn().mockResolvedValue({
            found: true,
            emitted: false,
            duplicate: false,
            trackedBranchChanged: false,
        }),
        recordConflict: options.conflictThrows
            ? jest.fn().mockRejectedValue(new Error('no Task service'))
            : jest.fn().mockResolvedValue({
                  taskId: 'task-1',
                  created: true,
                  commented: false,
                  agentId: null,
                  paths: [],
              }),
    };

    const hygiene = { apply: jest.fn().mockResolvedValue({ state: 'clean' }) };
    const rows = {
        findByWorkId: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(true),
    };
    const works = { findById: jest.fn().mockResolvedValue({ userId: USER_ID }) };
    const activity = { log: jest.fn().mockResolvedValue(undefined) };
    const specs = {
        getEffectiveSpec: jest.fn().mockResolvedValue({
            status: 'valid',
            spec:
                options.spec === undefined
                    ? { upstreamSync: { schedule: APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE } }
                    : options.spec,
        }),
    };
    const licenses = {
        previewUpstream: jest.fn().mockResolvedValue({ worse: false }),
        request: jest.fn().mockResolvedValue(undefined),
    };
    const privateCopies =
        options.privateCopies === false
            ? undefined
            : {
                  compare: jest.fn().mockResolvedValue({
                      aheadBy: 0,
                      behindBy: 2,
                      upstreamHeadSha: SHA_B,
                      capped: false,
                  }),
                  moveSyncBranch: jest.fn().mockResolvedValue('moved'),
              };
    const sleep = jest.fn().mockResolvedValue(undefined);

    const service = new AppUpstreamSyncService(
        states as never,
        git as never,
        hygiene as never,
        options.noRowRepository ? undefined : (rows as never),
        options.noWorkRepository ? undefined : (works as never),
        activity as never,
        options.noSpecSource ? undefined : (specs as never),
        options.noLicenseService ? undefined : (licenses as never),
        privateCopies as never,
    );

    return {
        service,
        states,
        git,
        calls,
        hygiene,
        rows,
        works,
        activity,
        specs,
        licenses,
        privateCopies,
        sleep,
    };
}

/** Every `force: true` anywhere in the recorded provider calls, as a path. */
function forcedWrites(value: unknown, path = '$'): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => forcedWrites(entry, `${path}[${index}]`));
    }
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
            key === 'force' && entry === true
                ? [`${path}.force`]
                : forcedWrites(entry, `${path}.${key}`),
        );
    }
    return [];
}

/**
 * The invariant of FR-39, asserted over **every** call the provider double
 * recorded: nothing is pushed to the upstream, no repository write names it, and
 * no argument anywhere carries `force: true`.
 */
function assertNoUpstreamWrite(harness: Harness): void {
    // 1. the calls that would write to (or merge into) the upstream never happen, and
    //    neither does a local clone the platform layer may not make (FR-63).
    expect(harness.calls.push).toHaveLength(0);
    expect(harness.calls.replaceRemote).toHaveLength(0);
    expect(harness.calls.mergePullRequest).toHaveLength(0);
    expect(harness.calls.cloneOrPull).toHaveLength(0);

    // 2. every write names the Work Repository, never the upstream (FR-39: the
    //    platform contributes from the fork; it never writes to somebody's project).
    for (const method of WRITE_METHODS) {
        for (const args of harness.calls[method]) {
            const target =
                method === 'createPullRequest'
                    ? (args[0] as { owner?: unknown; repo?: unknown })
                    : { owner: args[0], repo: args[1] };
            expect([method, String(target.owner)]).toEqual([method, OWNER]);
            expect([method, String(target.repo)]).toEqual([method, REPO]);
        }
    }

    // 3. no `force` write exists anywhere in this epic (FR-39, ACC-02-10).
    expect(forcedWrites(harness.calls)).toEqual([]);
}

/** Run one sync and assert the FR-39 invariant over everything it did. */
async function runSync(
    harness: Harness,
    payload: Record<string, unknown> = {},
    deps: AppUpstreamSyncDeps = {},
): Promise<AppUpstreamSyncRunResult> {
    const result = await harness.service.run(
        { workId: WORK_ID, trigger: 'schedule', ...payload } as never,
        { now: () => NOW, sleep: harness.sleep, ...deps },
    );
    assertNoUpstreamWrite(harness);
    return result;
}

/** The input the run handed `finishSync` — the one settle call site. */
function finishInput(harness: Harness): Record<string, unknown> {
    expect(harness.states.finishSync).toHaveBeenCalledTimes(1);
    return harness.states.finishSync.mock.calls[0][1] as Record<string, unknown>;
}

/** Every column patch the run wrote through the repository, merged. */
function rowPatch(harness: Harness): Record<string, unknown> {
    return Object.assign(
        {},
        ...harness.rows.update.mock.calls.map((call) => call[1] as Record<string, unknown>),
    );
}

/** The first argument of the first call to a provider method. */
function firstArgs(harness: Harness, method: ProviderMethod): unknown[] {
    expect(harness.calls[method].length).toBeGreaterThan(0);
    return harness.calls[method][0];
}

describe('AppUpstreamSyncService — the claim (T26: the lock is API-side, plan §6.3 steps 1-2)', () => {
    it('reports skipped/sync_in_progress without a provider call and without settling', async () => {
        const harness = makeHarness({ beginSync: { allowed: false, reason: 'sync_in_progress' } });

        const result = await runSync(harness);

        expect(harness.states.beginSync).toHaveBeenCalledWith(WORK_ID, 'schedule');
        expect(result.outcome).toBe('refused');
        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('sync_in_progress');
        expect(result.providerCalls).toBe(0);
        expect(harness.calls.getRepository).toHaveLength(0);
        // The claim belongs to whoever holds it: finishing it here would release a
        // lease this run never owned (FR-34).
        expect(harness.states.finishSync).not.toHaveBeenCalled();
    });

    it('reports the refusal code the state service gave (not_ready, no_upstream)', async () => {
        for (const reason of ['not_ready', 'no_upstream', 'not_found']) {
            const harness = makeHarness({ beginSync: { allowed: false, reason } });

            const result = await runSync(harness);

            expect(result.outcome).toBe('refused');
            expect(result.reason).toBe(reason);
            expect(harness.states.finishSync).not.toHaveBeenCalled();
        }
    });

    it('fails closed when the state service itself is unreachable', async () => {
        const harness = makeHarness();
        harness.states.beginSync.mockRejectedValue(new Error('proxy down'));

        const result = await runSync(harness);

        expect(result.outcome).toBe('refused');
        expect(result.reason).toBe('state_unavailable');
        expect(harness.states.finishSync).not.toHaveBeenCalled();
    });

    it('passes the payload trigger through to the claim and to the run', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 2,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        const result = await runSync(harness, { trigger: 'manual' });

        expect(harness.states.beginSync).toHaveBeenCalledWith(WORK_ID, 'manual');
        expect(result.trigger).toBe('manual');
    });

    it('does NOT call DistributedTaskLockService — the claim is the state service’s', () => {
        // Structural: the service is constructed with no lock collaborator at all, so
        // there is nothing for `run` to call even if someone wanted it to.
        const harness = makeHarness();

        expect(Object.keys(harness.service)).not.toContain('locks');
        expect((harness.service as unknown as Record<string, unknown>).locks).toBeUndefined();
    });
});

describe('AppUpstreamSyncService — every path that claimed releases the claim (T26 done-when)', () => {
    const cases: Array<{ name: string; setup: () => Harness; result: string; reason: string }> = [
        {
            name: 'fast_forwarded',
            setup: () =>
                makeHarness({
                    row: makeRow({ upstreamDefaultBranch: TRACKED_BRANCH }),
                    handlers: {
                        getForkDivergence: () => ({
                            aheadBy: 0,
                            behindBy: 3,
                            upstreamHeadSha: SHA_B,
                            forkHeadSha: SHA_A,
                        }),
                        syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
                    },
                }),
            result: 'fast_forwarded',
            reason: 'fast_forwarded',
        },
        {
            name: 'pull_request_opened',
            setup: () =>
                makeHarness({
                    handlers: {
                        getForkDivergence: () => ({
                            aheadBy: 1,
                            behindBy: 2,
                            upstreamHeadSha: SHA_B,
                            forkHeadSha: SHA_A,
                        }),
                    },
                }),
            result: 'pull_request_opened',
            reason: 'pull_request_opened',
        },
        {
            name: 'conflict',
            setup: () =>
                makeHarness({
                    handlers: {
                        getForkDivergence: () => ({
                            aheadBy: 1,
                            behindBy: 2,
                            upstreamHeadSha: SHA_B,
                            forkHeadSha: SHA_A,
                        }),
                        getPullRequestStatus: () => ({
                            number: 7,
                            state: 'open',
                            merged: false,
                            mergeable: false,
                            headSha: SHA_C,
                            ciState: 'unknown',
                            checks: [],
                        }),
                    },
                }),
            result: 'conflict',
            reason: 'conflict',
        },
        {
            name: 'paused',
            setup: () =>
                makeHarness({
                    handlers: {
                        getRepository: () =>
                            repository(UPSTREAM_OWNER, UPSTREAM_REPO, { archived: true }),
                    },
                }),
            result: 'paused',
            reason: 'upstream_archived',
        },
        {
            name: 'skipped (spec)',
            setup: () => makeHarness({ spec: { upstreamSync: { enabled: false } } }),
            result: 'skipped',
            reason: 'disabled_by_spec',
        },
        {
            name: 'failed (no row)',
            setup: () => makeHarness({ row: null }),
            result: 'failed',
            reason: 'state_not_found',
        },
    ];

    it.each(cases)('settles $name exactly once through finishSync', async (entry) => {
        const harness = entry.setup();

        const result = await runSync(harness);

        expect(result.outcome).toBe('settled');
        expect(result.result).toBe(entry.result);
        expect(result.reason).toBe(entry.reason);
        // The release: `finishSync` stamps `syncFinishedAt`, which is what makes
        // `syncStartedAt <= syncFinishedAt` and frees the Work for the next run.
        expect(harness.states.finishSync).toHaveBeenCalledTimes(1);
        expect(harness.states.finishSync).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ result: entry.result, reason: entry.reason }),
        );
    });

    it('never settles a run whose claim was refused, whatever the failure', async () => {
        const harness = makeHarness({ beginSync: { allowed: false, reason: 'sync_in_progress' } });

        await runSync(harness);

        expect(harness.states.finishSync).not.toHaveBeenCalled();
    });
});

describe('AppUpstreamSyncService — FR-39: nothing is pushed to the upstream and nothing is forced', () => {
    it('leaves the upstream untouched on the fast-forward path', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 5,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });

        await runSync(harness);

        expect(firstArgs(harness, 'syncForkBranch')).toEqual([
            OWNER,
            REPO,
            TRACKED_BRANCH,
            expect.objectContaining({ userId: USER_ID, providerId: 'github', workId: WORK_ID }),
        ]);
        // The merge-upstream call is a write to the FORK, which is the member's own
        // repository; the upstream is only ever read.
        expect(harness.calls.getRepository.map((args) => args[0])).toEqual([UPSTREAM_OWNER, OWNER]);
        assertNoUpstreamWrite(harness);
    });

    it('writes branch refs in the Work Repository only, and always force: false', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 2,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        await runSync(harness);

        expect(harness.calls.updateBranchRef).toHaveLength(1);
        const [, , , , refOptions] = firstArgs(harness, 'updateBranchRef');
        expect(refOptions).toEqual({ force: false });
        expect(harness.calls.createPullRequest).toHaveLength(1);
        const [prOptions] = firstArgs(harness, 'createPullRequest');
        expect(prOptions).toEqual(
            expect.objectContaining({
                owner: OWNER,
                repo: REPO,
                head: APP_UPSTREAM_SYNC_BRANCH,
                base: TRACKED_BRANCH,
            }),
        );
        assertNoUpstreamWrite(harness);
    });

    it('never merges, even when a pull request is open and mergeable', async () => {
        const harness = makeHarness({
            row: makeRow({ syncPullRequestNumber: 7, syncPullRequestUrl: 'https://x/7' }),
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 2,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                getPullRequest: () => ({
                    number: 7,
                    title: 'sync',
                    state: 'open',
                    head: APP_UPSTREAM_SYNC_BRANCH,
                    base: TRACKED_BRANCH,
                    url: 'https://x/7',
                    createdAt: '',
                    updatedAt: '',
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_updated');
        expect(harness.calls.mergePullRequest).toHaveLength(0);
    });
});

describe('AppUpstreamSyncService — the four pause states (§6.3 step 4)', () => {
    it('pauses on an unreadable upstream and emits app.upstream.unavailable once', async () => {
        const harness = makeHarness({ handlers: { getRepository: () => null } });

        const result = await runSync(harness);

        expect(result.result).toBe('paused');
        expect(result.reason).toBe('upstream_unavailable');
        expect(rowPatch(harness)).toEqual(
            expect.objectContaining({ upstreamStatus: 'unavailable' }),
        );
        expect(rowPatch(harness).upstreamCheckedAt).toBeInstanceOf(Date);
        expect(harness.activity.log).toHaveBeenCalledTimes(1);
        expect(harness.activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'app.upstream.unavailable',
                actionType: 'app_upstream',
                workId: WORK_ID,
                userId: USER_ID,
            }),
        );
        const settled = finishInput(harness);
        expect(settled.nextSyncAt).toBeNull();
    });

    it('does not emit app.upstream.unavailable a second time (one-time event)', async () => {
        const harness = makeHarness({
            row: makeRow({ upstreamStatus: 'unavailable' }),
            handlers: { getRepository: () => null },
        });

        const result = await runSync(harness);

        expect(result.reason).toBe('upstream_unavailable');
        expect(harness.activity.log).not.toHaveBeenCalled();
    });

    it('pauses on an archived upstream without pretending it will come back', async () => {
        const harness = makeHarness({
            handlers: {
                getRepository: (owner: string, name: string) =>
                    repository(owner, name, { archived: true }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('paused');
        expect(result.reason).toBe('upstream_archived');
        expect(rowPatch(harness)).toEqual(expect.objectContaining({ upstreamStatus: 'archived' }));
        // Nothing to re-check: only the member can unarchive it.
        expect(finishInput(harness).nextSyncAt).toBeNull();
        expect(harness.calls.getForkDivergence).toHaveLength(0);
    });

    it('pauses when the Work Repository is gone, emits app.fork.missing once and clears the clock', async () => {
        const harness = makeHarness({
            handlers: {
                getRepository: (owner: string, name: string) =>
                    owner === UPSTREAM_OWNER ? repository(owner, name) : null,
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('paused');
        expect(result.reason).toBe('data_repository_missing');
        expect(rowPatch(harness)).toEqual(
            expect.objectContaining({ dataRepositoryStatus: 'missing' }),
        );
        expect(harness.activity.log).toHaveBeenCalledTimes(1);
        expect(harness.activity.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'app.fork.missing', actionType: 'app_fork' }),
        );
        expect(finishInput(harness).nextSyncAt).toBeNull();
    });

    it('does not repeat app.fork.missing while the repository stays missing', async () => {
        const harness = makeHarness({
            row: makeRow({ dataRepositoryStatus: 'missing' }),
            handlers: {
                getRepository: (owner: string, name: string) =>
                    owner === UPSTREAM_OWNER ? repository(owner, name) : null,
            },
        });

        const result = await runSync(harness);

        expect(result.reason).toBe('data_repository_missing');
        expect(harness.activity.log).not.toHaveBeenCalled();
    });

    it('pauses a private copy whose upstream is over 500 MB (FR-45, ACC-02-15)', async () => {
        const harness = makeHarness({
            row: makeRow({ relation: 'private-copy' }),
            handlers: {
                getRepository: (owner: string, name: string) =>
                    repository(owner, name, owner === UPSTREAM_OWNER ? { sizeKb: 512_001 } : {}),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('paused');
        expect(result.reason).toBe('too_large_for_private_copy');
        // The refusal happens before any compare: there is nothing to compare.
        expect(harness.privateCopies?.compare).not.toHaveBeenCalled();
        expect(finishInput(harness).nextSyncAt).toBeNull();
    });

    it('syncs a private copy whose upstream is exactly 500 MB (the boundary runs)', async () => {
        const harness = makeHarness({
            row: makeRow({ relation: 'private-copy' }),
            handlers: {
                getRepository: (owner: string, name: string) =>
                    repository(owner, name, owner === UPSTREAM_OWNER ? { sizeKb: 512_000 } : {}),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(harness.privateCopies?.compare).toHaveBeenCalledTimes(1);
    });
});

describe('AppUpstreamSyncService — the rename, the licence and the fast-forward (§6.3 steps 4-6)', () => {
    it('follows upstream’s renamed default branch and records the old name (FR-43, ACC-02-19)', async () => {
        const harness = makeHarness({
            row: makeRow({ upstreamDefaultBranch: 'master' }),
            handlers: {
                getRepository: (owner: string, name: string) =>
                    repository(
                        owner,
                        name,
                        owner === UPSTREAM_OWNER ? { defaultBranch: 'main' } : {},
                    ),
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 4,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });

        const result = await runSync(harness);

        expect(rowPatch(harness)).toEqual(
            expect.objectContaining({
                upstreamDefaultBranch: 'main',
                upstreamPreviousDefaultBranch: 'master',
            }),
        );
        // The NEW name is what the compare and the merge are called with.
        const [, , , , upstreamBranch] = firstArgs(harness, 'getForkDivergence');
        expect(upstreamBranch).toBe('main');
        expect(result.result).toBe('fast_forwarded');
    });

    it('fast-forwards a behind-only fork, records the count and the head (FR-35, FR-40, ACC-02-09)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 6,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('fast_forwarded');
        expect(result.reason).toBe('fast_forwarded');
        expect(result.commits).toBe(6);
        expect(result.toSha).toBe(SHA_B);
        const settled = finishInput(harness);
        expect(settled.result).toBe('fast_forwarded');
        expect(settled.commits).toBe(6);
        expect(settled.toSha).toBe(SHA_B);
        // FR-40: the tracked branch moved, so the licence gate is asked again and
        // hygiene runs — and only then.
        expect(settled.trackedBranchChanged).toBe(true);
        expect(harness.licenses.request).toHaveBeenCalledWith(WORK_ID, 'upstream_synced');
        expect(harness.hygiene.apply).toHaveBeenCalledWith(WORK_ID);
        expect(result.licenseRequested).toBe(true);
    });

    it('treats a provider `merged` outcome as a fast-forward (a race, §4.3)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 2,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'merged' }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('fast_forwarded');
        expect(result.commits).toBe(2);
    });

    it('turns a fast-forward into a pull request when the licence got worse (FR-37, ACC-02-12)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });
        harness.licenses.previewUpstream.mockResolvedValue({ worse: true });

        const result = await runSync(harness);

        expect(harness.licenses.previewUpstream).toHaveBeenCalledWith(
            WORK_ID,
            UPSTREAM_OWNER,
            UPSTREAM_REPO,
            SHA_B,
        );
        // The fast-forward never happens…
        expect(harness.calls.syncForkBranch).toHaveLength(0);
        // …and the pull request carries it, with the reason saying why.
        expect(result.result).toBe('pull_request_opened');
        expect(result.reason).toBe('license_worse');
        expect(harness.calls.createPullRequest).toHaveLength(1);
        // A pull request does not move the tracked branch, so FR-40's follow-ups wait.
        expect(finishInput(harness).trackedBranchChanged).toBe(false);
        expect(harness.licenses.request).not.toHaveBeenCalled();
        expect(harness.hygiene.apply).not.toHaveBeenCalled();
    });

    it('takes the pull-request path when the licence gate cannot answer (fail closed)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });
        harness.licenses.previewUpstream.mockRejectedValue(new Error('gate down'));

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(result.reason).toBe('license_worse');
        expect(harness.calls.syncForkBranch).toHaveLength(0);
    });

    it('REFUSES the fast-forward when no licence service is bound (FR-37 fails CLOSED)', async () => {
        // This case asserted `fast_forwarded` until 2026-09-21, citing `plan.md`'s
        // “absent ⇒ proceed” default. That default was measured to be the ONLY answer the
        // gate ever gave: `APP_UPSTREAM_LICENSE_SERVICE` is provided by no Nest module
        // anywhere in the tree, so `noLicenseService: true` is not an edge case — it is
        // production. FR-37 exists to stop upstream code whose licence got worse being
        // fast-forwarded into a member's repository unreviewed, and a gate that answers
        // “proceed” whenever it cannot run does not do that.
        //
        // The two “I don't know” paths now agree: absent service and throwing service both
        // take the pull-request path (the throwing case is the `it` directly above, which
        // has always been `pull_request_opened` / `license_worse`). The case is kept, with
        // its expectation inverted, because it is the only place that pins what an absent
        // licence service means.
        const harness = makeHarness({
            noLicenseService: true,
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(result.reason).toBe('license_worse');
        // Nothing was fast-forwarded: the refusal happens before the sync call.
        expect(harness.calls.syncForkBranch).toHaveLength(0);
        // The re-evaluation is not requestable either — and that is logged, not fatal.
        expect(result.licenseRequested).toBe(false);
    });

    it('takes the pull-request path when the merge-upstream call races with an upstream push (§9.2)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => {
                    throw new GitProviderRequestError('conflict', 409);
                },
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(harness.calls.createPullRequest).toHaveLength(1);
    });

    it('takes the pull-request path when the merge-upstream call answers a conflict', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'conflict' }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(harness.calls.createPullRequest).toHaveLength(1);
    });

    it('reports up_to_date when the fork already has upstream’s head', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 3,
                    behindBy: 0,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('up_to_date');
        expect(result.reason).toBe('up_to_date');
        expect(result.commits).toBe(0);
        expect(harness.calls.createPullRequest).toHaveLength(0);
        expect(harness.calls.syncForkBranch).toHaveLength(0);
        expect(harness.hygiene.apply).not.toHaveBeenCalled();
    });

    it('records a failing provider reason as failed/<reason> (§6.3 step 9)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => {
                    throw new GitProviderRequestError('permission_missing', 403, {
                        permission: 'contents',
                    });
                },
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('failed');
        expect(result.reason).toBe('permission_missing');
    });

    it('maps an unsupported capability to failed/provider_unsupported (plan §7)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => {
                    throw new GitOperationNotSupportedError('getForkDivergence', 'github');
                },
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('failed');
        expect(result.reason).toBe('provider_unsupported');
    });
});

describe('AppUpstreamSyncService — the pull request (FR-36, FR-39, ACC-02-10)', () => {
    const diverged = {
        getForkDivergence: () => ({
            aheadBy: 1,
            behindBy: 2,
            upstreamHeadSha: SHA_B,
            forkHeadSha: SHA_A,
        }),
    };

    it('creates the sync branch when it does not exist, then opens one pull request', async () => {
        const harness = makeHarness({
            handlers: {
                ...diverged,
                updateBranchRef: () => {
                    throw new GitProviderRequestError('not_found', 404);
                },
            },
        });

        const result = await runSync(harness);

        expect(harness.calls.updateBranchRef).toHaveLength(1);
        expect(harness.calls.createBranchFromSha).toHaveLength(1);
        expect(firstArgs(harness, 'createBranchFromSha').slice(0, 4)).toEqual([
            OWNER,
            REPO,
            APP_UPSTREAM_SYNC_BRANCH,
            SHA_B,
        ]);
        expect(harness.calls.createPullRequest).toHaveLength(1);
        expect(result.result).toBe('pull_request_opened');
        // A fork with commits of its own never takes the merge-upstream route (FR-36):
        // the pull request is the only thing that can carry a divergence.
        expect(harness.calls.syncForkBranch).toHaveLength(0);
        expect(harness.calls.mergePullRequest).toHaveLength(0);
        expect(result.pullRequest).toEqual({
            number: 7,
            url: 'https://github.com/me/widgets/pull/7',
        });
        const settled = finishInput(harness);
        expect(settled.pullRequestNumber).toBe(7);
        expect(settled.pullRequestUrl).toBe('https://github.com/me/widgets/pull/7');
        expect(settled.commits).toBe(2);
        expect(settled.toSha).toBe(SHA_B);
    });

    it('reuses the open pull request on the next sync — update, never a second pull request', async () => {
        const harness = makeHarness({
            row: makeRow({ syncPullRequestNumber: 7, syncPullRequestUrl: 'https://x/7' }),
            handlers: {
                ...diverged,
                getPullRequest: () => ({
                    number: 7,
                    title: 'sync',
                    state: 'open',
                    head: APP_UPSTREAM_SYNC_BRANCH,
                    base: TRACKED_BRANCH,
                    url: 'https://x/7',
                    createdAt: '',
                    updatedAt: '',
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_updated');
        expect(result.reason).toBe('pull_request_updated');
        // The branch moved, which is what makes the open pull request carry the range.
        expect(harness.calls.updateBranchRef).toHaveLength(1);
        expect(harness.calls.createPullRequest).toHaveLength(0);
        // …and a diverged fork is never fast-forwarded, and never merged (FR-36, FR-39).
        expect(harness.calls.syncForkBranch).toHaveLength(0);
        expect(harness.calls.mergePullRequest).toHaveLength(0);
    });

    it('finds the open pull request by scanning when the stored number is stale', async () => {
        const harness = makeHarness({
            row: makeRow({ syncPullRequestNumber: 4 }),
            handlers: {
                ...diverged,
                getPullRequest: () => null,
                listPullRequests: () => [
                    {
                        number: 12,
                        title: 'sync',
                        state: 'open',
                        head: APP_UPSTREAM_SYNC_BRANCH,
                        base: TRACKED_BRANCH,
                        url: 'https://x/12',
                        createdAt: '',
                        updatedAt: '',
                    },
                ],
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_updated');
        expect(result.pullRequest).toEqual({ number: 12, url: 'https://x/12' });
        expect(harness.calls.createPullRequest).toHaveLength(0);
    });

    it('does not reopen a closed pull request at the same head (S26)', async () => {
        const harness = makeHarness({
            row: makeRow({ syncPullRequestNumber: 9, syncPullRequestUrl: 'https://x/9' }),
            handlers: {
                ...diverged,
                getPullRequest: () => ({
                    number: 9,
                    title: 'sync',
                    state: 'closed',
                    head: APP_UPSTREAM_SYNC_BRANCH,
                    base: TRACKED_BRANCH,
                    url: 'https://x/9',
                    createdAt: '',
                    updatedAt: '',
                }),
                getPullRequestStatus: () => ({
                    number: 9,
                    state: 'closed',
                    merged: false,
                    mergeable: null,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('pull_request_closed');
        expect(harness.calls.createPullRequest).toHaveLength(0);
        expect(finishInput(harness).pullRequestClosedHeadSha).toBe(SHA_B);
    });

    it('opens a fresh pull request once upstream moves past the closed head', async () => {
        const harness = makeHarness({
            row: makeRow({
                syncPullRequestNumber: 9,
                syncPullRequestClosedHeadSha: SHA_A,
            }),
            handlers: {
                ...diverged,
                getPullRequest: () => ({
                    number: 9,
                    title: 'sync',
                    state: 'closed',
                    head: APP_UPSTREAM_SYNC_BRANCH,
                    base: TRACKED_BRANCH,
                    url: 'https://x/9',
                    createdAt: '',
                    updatedAt: '',
                }),
                getPullRequestStatus: () => ({
                    number: 9,
                    state: 'closed',
                    merged: false,
                    mergeable: null,
                    headSha: SHA_A,
                    ciState: 'unknown',
                    checks: [],
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(harness.calls.createPullRequest).toHaveLength(1);
    });

    it('re-reads `mergeable` three times, 5 s apart, and opens without a verdict (§9.2)', async () => {
        const harness = makeHarness({
            handlers: {
                ...diverged,
                getPullRequestStatus: () => ({
                    number: 7,
                    state: 'open',
                    merged: false,
                    mergeable: null,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
            },
        });

        const result = await runSync(harness);

        // One read plus three re-reads.
        expect(harness.calls.getPullRequestStatus).toHaveLength(4);
        expect(result.sleeps).toEqual([5_000, 5_000, 5_000]);
        expect(result.result).toBe('pull_request_opened');
        // No verdict is not a conflict: no Task.
        expect(harness.states.recordConflict).not.toHaveBeenCalled();
    });

    it('stops re-reading as soon as GitHub answers', async () => {
        let call = 0;
        const harness = makeHarness({
            handlers: {
                ...diverged,
                getPullRequestStatus: () => {
                    call += 1;
                    return {
                        number: 7,
                        state: 'open',
                        merged: false,
                        mergeable: call < 2 ? null : true,
                        headSha: SHA_B,
                        ciState: 'unknown',
                        checks: [],
                    };
                },
            },
        });

        const result = await runSync(harness);

        expect(harness.calls.getPullRequestStatus).toHaveLength(2);
        expect(result.sleeps).toEqual([5_000]);
        expect(result.result).toBe('pull_request_opened');
    });

    it('records the conflict Task when GitHub reports the pull request as conflicting', async () => {
        const harness = makeHarness({
            handlers: {
                ...diverged,
                getPullRequestStatus: () => ({
                    number: 7,
                    state: 'open',
                    merged: false,
                    mergeable: false,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
                getPullRequestFiles: () => [
                    { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
                    { filename: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 },
                ],
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('conflict');
        expect(result.reason).toBe('conflict');
        expect(harness.states.recordConflict).toHaveBeenCalledTimes(1);
        expect(harness.states.recordConflict).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({
                pr: { number: 7, url: 'https://github.com/me/widgets/pull/7' },
                toSha: SHA_B,
                commits: 2,
                paths: ['src/a.ts', 'src/b.ts'],
            }),
        );
        expect(result.conflict?.taskId).toBe('task-1');
    });

    it('caps the conflict paths at 50 and de-duplicates them (FR-38)', async () => {
        const files = Array.from({ length: 60 }, (_, index) => ({
            filename: `src/f${index}.ts`,
            status: 'modified',
            additions: 1,
            deletions: 1,
        }));
        const harness = makeHarness({
            handlers: {
                ...diverged,
                getPullRequestStatus: () => ({
                    number: 7,
                    state: 'open',
                    merged: false,
                    mergeable: false,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
                getPullRequestFiles: () => [
                    { filename: 'src/f0.ts', status: 'modified', additions: 1, deletions: 1 },
                    ...files,
                ],
            },
        });

        await runSync(harness);

        const input = harness.states.recordConflict.mock.calls[0][1] as { paths: string[] };
        expect(input.paths).toHaveLength(50);
        expect(new Set(input.paths).size).toBe(50);
        expect(input.paths[0]).toBe('src/f0.ts');
    });

    it('records the conflict with task_create_failed when the Task cannot be filed (§9.2)', async () => {
        const harness = makeHarness({
            conflictThrows: true,
            handlers: {
                ...diverged,
                getPullRequestStatus: () => ({
                    number: 7,
                    state: 'open',
                    merged: false,
                    mergeable: false,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('conflict');
        expect(result.reason).toBe('task_create_failed');
    });

    it('leaves the conflict paths to the API side when the file read fails', async () => {
        const harness = makeHarness({
            handlers: {
                ...diverged,
                getPullRequestStatus: () => ({
                    number: 7,
                    state: 'open',
                    merged: false,
                    mergeable: false,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
                getPullRequestFiles: () => {
                    throw new GitProviderRequestError('unprocessable', 422);
                },
            },
        });

        await runSync(harness);

        const input = harness.states.recordConflict.mock.calls[0][1] as { paths?: unknown };
        expect(input.paths).toBeNull();
    });
});

describe('AppUpstreamSyncService — rewritten history: nothing is ever force-moved (FR-39, ACC-02-10)', () => {
    const diverged = {
        getForkDivergence: () => ({
            aheadBy: 1,
            behindBy: 2,
            upstreamHeadSha: SHA_B,
            forkHeadSha: SHA_A,
        }),
        updateBranchRef: () => {
            throw new GitProviderRequestError('unprocessable', 422);
        },
    };

    it('fails with upstream_history_rewritten while the sync pull request is still open', async () => {
        const harness = makeHarness({
            row: makeRow({ syncPullRequestNumber: 7, syncPullRequestUrl: 'https://x/7' }),
            handlers: {
                ...diverged,
                getPullRequest: () => ({
                    number: 7,
                    title: 'sync',
                    state: 'open',
                    head: APP_UPSTREAM_SYNC_BRANCH,
                    base: TRACKED_BRANCH,
                    url: 'https://x/7',
                    createdAt: '',
                    updatedAt: '',
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('failed');
        expect(result.reason).toBe('upstream_history_rewritten');
        // Nothing was deleted, nothing was recreated, nothing was forced.
        expect(harness.calls.deleteBranch).toHaveLength(0);
        expect(harness.calls.createBranchFromSha).toHaveLength(0);
        expect(forcedWrites(harness.calls)).toEqual([]);
    });

    it('deletes and recreates the platform branch once the pull request is closed', async () => {
        const harness = makeHarness({
            handlers: diverged,
        });

        const result = await runSync(harness);

        expect(harness.calls.deleteBranch).toHaveLength(1);
        expect(harness.calls.createBranchFromSha).toHaveLength(1);
        expect(firstArgs(harness, 'deleteBranch').slice(0, 3)).toEqual([
            OWNER,
            REPO,
            APP_UPSTREAM_SYNC_BRANCH,
        ]);
        // Recreated at upstream's head, and the pull request follows.
        expect(firstArgs(harness, 'createBranchFromSha')[3]).toBe(SHA_B);
        expect(result.result).toBe('pull_request_opened');
        expect(forcedWrites(harness.calls)).toEqual([]);
    });

    it('records a not-fast-forward that is NOT unprocessable as a failure, not as a rewrite', async () => {
        const harness = makeHarness({
            handlers: {
                ...diverged,
                updateBranchRef: () => {
                    throw new GitProviderRequestError('secondary_rate_limited', 403, {
                        retryAt: new Date(NOW + 120_000).toISOString(),
                    });
                },
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('skipped_rate_limited');
        expect(harness.calls.deleteBranch).toHaveLength(0);
    });
});

describe('AppUpstreamSyncService — the private copy (FR-63, ACC-02-15, ACC-02-27)', () => {
    it('counts from the merge base through the capability and caps at 10000+', async () => {
        const harness = makeHarness({
            row: makeRow({ relation: 'private-copy' }),
            handlers: {},
        });
        (harness.privateCopies as { compare: jest.Mock }).compare.mockResolvedValue({
            aheadBy: 0,
            behindBy: 10_000,
            upstreamHeadSha: SHA_B,
            capped: true,
        });

        const result = await runSync(harness);

        expect(harness.privateCopies?.compare).toHaveBeenCalledWith({
            workId: WORK_ID,
            owner: OWNER,
            repo: REPO,
            branch: TRACKED_BRANCH,
            upstreamOwner: UPSTREAM_OWNER,
            upstreamRepo: UPSTREAM_REPO,
            upstreamBranch: TRACKED_BRANCH,
        });
        expect(result.divergence).toEqual(
            expect.objectContaining({ aheadBy: 0, behindBy: 10_000, capped: true }),
        );
        expect(rowPatch(harness)).toEqual(expect.objectContaining({ behindBy: 10_000 }));
        // The capability moves the sync branch; the platform layer never shells out and
        // never uses the fork network's ref methods for a private copy.
        expect(harness.privateCopies?.moveSyncBranch).toHaveBeenCalledWith({
            workId: WORK_ID,
            owner: OWNER,
            repo: REPO,
            headSha: SHA_B,
        });
        expect(harness.calls.updateBranchRef).toHaveLength(0);
        expect(result.result).toBe('pull_request_opened');
    });

    it('reports up_to_date without moving the branch when the copy is current', async () => {
        const harness = makeHarness({ row: makeRow({ relation: 'private-copy' }) });
        (harness.privateCopies as { compare: jest.Mock }).compare.mockResolvedValue({
            aheadBy: 0,
            behindBy: 0,
            upstreamHeadSha: SHA_B,
            capped: false,
        });

        const result = await runSync(harness);

        expect(result.result).toBe('up_to_date');
        expect(harness.privateCopies?.moveSyncBranch).not.toHaveBeenCalled();
        expect(harness.calls.createPullRequest).toHaveLength(0);
    });

    it('fails closed with provider_unsupported when the capability is not bound (plan §7)', async () => {
        const harness = makeHarness({
            row: makeRow({ relation: 'private-copy' }),
            privateCopies: false,
        });

        const result = await runSync(harness);

        expect(result.result).toBe('failed');
        expect(result.reason).toBe('provider_unsupported');
        // Nothing was written to the repository by the platform layer itself.
        expect(harness.calls.updateBranchRef).toHaveLength(0);
        expect(harness.calls.createBranchFromSha).toHaveLength(0);
    });
});

describe('AppUpstreamSyncService — the spec gates (FR-64, ACC-02-28)', () => {
    it('leaves the scheduled run unset when the spec turns sync off', async () => {
        const harness = makeHarness({ spec: { upstreamSync: { enabled: false } } });

        const result = await runSync(harness);

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('disabled_by_spec');
        expect(result.providerCalls).toBe(0);
        expect(harness.calls.getRepository).toHaveLength(0);
        // The claim is still released — the Work is not left locked for 30 minutes.
        expect(finishInput(harness).nextSyncAt).toBeNull();
        expect(result.nextSyncAt).toBeNull();
    });

    it('still syncs on a manual Sync now when the schedule is off (ACC-02-28)', async () => {
        const harness = makeHarness({
            spec: { upstreamSync: { enabled: false } },
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });

        const result = await runSync(harness, { trigger: 'manual' });

        expect(result.result).toBe('fast_forwarded');
        expect(harness.calls.syncForkBranch).toHaveLength(1);
        // …and the next *scheduled* run stays unset.
        expect(result.nextSyncAt).toBeNull();
    });

    it('refuses a mode it cannot honour, on every trigger', async () => {
        for (const trigger of ['schedule', 'manual', 'divergence', 'merged']) {
            const harness = makeHarness({ spec: { upstreamSync: { mode: 'rebase' } } });

            const result = await runSync(harness, { trigger });

            expect(result.result).toBe('skipped');
            expect(result.reason).toBe('disabled_by_spec');
            expect(harness.calls.getRepository).toHaveLength(0);
        }
    });

    it('reads the spec on every run, so a spec change needs no cache to expire (FR-64)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 0,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        await runSync(harness);
        await runSync(harness);

        expect(harness.specs.getEffectiveSpec).toHaveBeenCalledTimes(2);
    });

    it('stores the effective schedule for the card (FR-32)', async () => {
        const harness = makeHarness({ spec: { upstreamSync: { schedule: '30 2 * * *' } } });

        await runSync(harness);

        expect(rowPatch(harness).syncSchedule).toBe('30 2 * * *');
        const settled = finishInput(harness);
        const expected = computeNextUpstreamSync('30 2 * * *', new Date(NOW), WORK_ID);
        expect((settled.nextSyncAt as Date).getTime()).toBe((expected as Date).getTime());
    });

    it('falls back to the documented defaults when the spec source is unbound (§6.4)', async () => {
        const harness = makeHarness({
            noSpecSource: true,
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 0,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.settings.schedule).toBe(APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE);
        expect(result.settings.enabled).toBe(true);
        expect(rowPatch(harness).syncSchedule).toBe(APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE);
    });
});

describe('AppUpstreamSyncService — the rate-limit budget (FR-49…FR-52, ACC-02-16)', () => {
    it('skips a run whose stored window has not passed, before any provider call', async () => {
        const until = new Date(NOW + 600_000);
        const harness = makeHarness({ row: makeRow({ rateLimitedUntil: until }) });

        const result = await runSync(harness);

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('skipped_rate_limited');
        expect(result.providerCalls).toBe(0);
        expect(harness.calls.getRepository).toHaveLength(0);
        const settled = finishInput(harness);
        expect(settled.rateLimited).toBe(true);
        // The stored value is `reset + 60 s`, and the skip re-records exactly it.
        expect(settled.rateLimitedUntil).toBe(until.getTime());
        expect(result.rateLimitedUntil).toBe(until.toISOString());
    });

    it('waits for the provider’s reset plus 60 s on a primary limit (FR-50)', async () => {
        const resetAt = new Date(NOW + 300_000).toISOString();
        const harness = makeHarness({
            handlers: {
                getRepository: () => {
                    throw new GitProviderRequestError('rate_limited', 403, { retryAt: resetAt });
                },
            },
        });

        const result = await runSync(harness);

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('skipped_rate_limited');
        expect(finishInput(harness).rateLimitedUntil).toBe(
            NOW + 300_000 + APP_RATE_LIMIT_RESET_GRACE_MS,
        );
    });

    it('doubles the secondary backoff per consecutive rate-limited run, to a one-hour ceiling (FR-51, FR-52)', async () => {
        const cases: Array<[number, number]> = [
            [0, 60_000],
            [1, 120_000],
            [2, 240_000],
            [3, 480_000],
            [6, APP_RATE_LIMIT_BACKOFF_MAX_MS],
            [12, APP_RATE_LIMIT_BACKOFF_MAX_MS],
        ];

        for (const [streak, expected] of cases) {
            const harness = makeHarness({
                row: makeRow({ consecutiveRateLimited: streak }),
                handlers: {
                    getRepository: () => {
                        throw new GitProviderRequestError('secondary_rate_limited', 403);
                    },
                },
            });

            const result = await runSync(harness);

            expect(result.reason).toBe('skipped_rate_limited');
            expect(finishInput(harness).rateLimitedUntil).toBe(NOW + expected);
            // FR-52: the state service increments its own counter from this flag, and
            // the third consecutive run is what makes the notice persistent.
            expect(finishInput(harness).rateLimited).toBe(true);
        }
    });

    it('honours the provider’s own retry-at on a secondary limit', async () => {
        const retryAt = new Date(NOW + 90_000).toISOString();
        const harness = makeHarness({
            handlers: {
                getRepository: () => {
                    throw new GitProviderRequestError('secondary_rate_limited', 403, { retryAt });
                },
            },
        });

        await runSync(harness);

        expect(finishInput(harness).rateLimitedUntil).toBe(NOW + 90_000);
    });

    it('counts a rate-limited run as the next one in the streak (FR-52’s persistent notice)', async () => {
        const harness = makeHarness({
            row: makeRow({ consecutiveRateLimited: 2 }),
            handlers: {
                getRepository: () => {
                    throw new GitProviderRequestError('secondary_rate_limited', 403);
                },
            },
        });

        await runSync(harness);

        // Third consecutive run: the state service stores 3, which is
        // APP_RATE_LIMITED_PERSISTENT_AFTER, and the backoff used the third position.
        expect(finishInput(harness).rateLimitedUntil).toBe(NOW + 240_000);
        expect(finishInput(harness).rateLimited).toBe(true);
    });

    it('stops at the provider-call budget and records skipped/skipped_budget (FR-49, §9.2)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 2,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        // A budget of three: upstream read, data read, compare — then the pull-request
        // path needs a fourth call it may not make.
        const result = await runSync(harness, {}, { budget: new ProviderCallBudget(3) });

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('skipped_budget');
        expect(result.providerCalls).toBe(3);
        expect(harness.calls.createPullRequest).toHaveLength(0);
        expect(finishInput(harness).result).toBe('skipped');
        expect(finishInput(harness).reason).toBe('skipped_budget');
    });

    it('makes at most 20 provider calls, and refuses the 21st (FR-49)', async () => {
        const budget = new ProviderCallBudget();

        for (let index = 0; index < APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS; index++) {
            await budget.call(async () => index);
        }

        expect(APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS).toBe(20);
        expect(budget.calls).toBe(20);
        expect(budget.exhausted).toBe(true);
        await expect(budget.call(async () => 'one-too-many')).rejects.toBeInstanceOf(
            ProviderBudgetExceededError,
        );
        // A refused call is not a call: the count does not move.
        expect(budget.calls).toBe(20);
    });

    it('decides whether a run may start with the contract’s own FR-50 predicate', () => {
        const budget = new ProviderCallBudget();

        // Nobody reported a budget yet: nothing to refuse.
        expect(budget.allowsStart()).toBe(true);

        budget.observe({ remaining: 300 });
        expect(budget.allowsStart()).toBe(true);

        budget.observe({ remaining: 299 });
        expect(budget.allowsStart()).toBe(false);
        expect(budget.lastRemaining).toBe(299);
    });

    it('never exceeds the budget on a long pull-request path', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 2,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                getPullRequestStatus: () => ({
                    number: 7,
                    state: 'open',
                    merged: false,
                    mergeable: null,
                    headSha: SHA_B,
                    ciState: 'unknown',
                    checks: [],
                }),
            },
        });

        const result = await runSync(harness);

        expect(result.providerCalls).toBeLessThanOrEqual(APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS);
    });
});

describe('AppUpstreamSyncService — the divergence-only dispatch and the reading (§6.3 step 5, FR-46/FR-48)', () => {
    it('compares, records the counts and settles with the outcome already on the row', async () => {
        const harness = makeHarness({
            row: makeRow({
                lastSyncResult: 'fast_forwarded',
                lastSyncReason: 'fast_forwarded',
                lastSyncCommitCount: 3,
                lastSyncedUpstreamSha: SHA_A,
                syncPullRequestNumber: null,
            }),
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 2,
                    behindBy: 4,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        const result = await runSync(harness, { trigger: 'divergence' });

        expect(harness.calls.syncForkBranch).toHaveLength(0);
        expect(harness.calls.createPullRequest).toHaveLength(0);
        expect(harness.calls.getPullRequest).toHaveLength(0);
        expect(rowPatch(harness)).toEqual(
            expect.objectContaining({
                aheadBy: 2,
                behindBy: 4,
                upstreamHeadSha: SHA_B,
            }),
        );
        // The row keeps the outcome it had: the compare is not a sync.
        const settled = finishInput(harness);
        expect(settled.result).toBe('fast_forwarded');
        expect(settled.commits).toBe(3);
        expect(settled.toSha).toBe(SHA_A);
        expect(result.divergence).toEqual(
            expect.objectContaining({ aheadBy: 2, behindBy: 4, capped: false }),
        );
        expect(harness.hygiene.apply).not.toHaveBeenCalled();
        expect(harness.licenses.request).not.toHaveBeenCalled();
    });

    it('emits app.upstream.behind when behind goes from 0 to more than 0 (FR-48)', async () => {
        const harness = makeHarness({
            row: makeRow({ behindEventCount: 0 }),
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        const result = await runSync(harness);

        expect(harness.activity.log).toHaveBeenCalledTimes(1);
        expect(harness.activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'app.upstream.behind',
                actionType: 'app_upstream',
                details: expect.objectContaining({ behindBy: 3 }),
            }),
        );
        expect(result.events).toEqual(['app.upstream.behind']);
    });

    it('emits again only when behind grows by 25 or more since the last emission (FR-48)', async () => {
        const grown = makeHarness({
            row: makeRow({ behindEventCount: 10 }),
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 35,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });
        const small = makeHarness({
            row: makeRow({ behindEventCount: 10 }),
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 12,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        await runSync(grown);
        await runSync(small);

        expect(grown.activity.log).toHaveBeenCalledTimes(1);
        expect(small.activity.log).not.toHaveBeenCalled();
    });

    it('records the reading even when nothing else happens', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 4,
                    behindBy: 0,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });

        await runSync(harness);

        const patch = rowPatch(harness);
        expect(patch.divergenceComputedAt).toBeInstanceOf(Date);
        expect(patch.upstreamStatus).toBe('available');
        expect(patch.behindEventCount).toBe(0);
    });
});

describe('AppUpstreamSyncService — the paths that cannot reach a repository at all', () => {
    it('fails closed when the state row cannot be read (T28 must bind the repository)', async () => {
        const harness = makeHarness({ noRowRepository: true });

        const result = await runSync(harness);

        expect(result.result).toBe('failed');
        expect(result.reason).toBe('state_not_found');
        expect(harness.calls.getRepository).toHaveLength(0);
        // The claim was taken, so it is released.
        expect(harness.states.finishSync).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the Work has no owner whose credential could be used', async () => {
        const harness = makeHarness({ noWorkRepository: true });

        const result = await runSync(harness);

        expect(result.result).toBe('failed');
        expect(result.reason).toBe('work_not_found');
        expect(harness.calls.getRepository).toHaveLength(0);
    });

    it('refuses a Work with no upstream coordinates instead of guessing them', async () => {
        const harness = makeHarness({ row: makeRow({ upstreamOwner: null, upstreamRepo: null }) });

        const result = await runSync(harness);

        expect(result.result).toBe('skipped');
        expect(result.reason).toBe('no_upstream');
        expect(harness.calls.getRepository).toHaveLength(0);
    });

    it('answers an empty workId without touching the state service', async () => {
        const harness = makeHarness();

        const result = await harness.service.run({ trigger: 'schedule' } as never, {
            now: () => NOW,
        });

        expect(result.outcome).toBe('refused');
        expect(result.result).toBe('failed');
        expect(result.reason).toBe('work_not_found');
        expect(harness.states.beginSync).not.toHaveBeenCalled();
        expect(harness.states.finishSync).not.toHaveBeenCalled();
    });
});

describe('AppUpstreamSyncService — the run never throws', () => {
    const failures = [
        new Error('boom'),
        new GitProviderRequestError('not_found', 404),
        new GitProviderRequestError('unauthorized', 401),
        new GitProviderRequestError('sso_authorization_required', 403),
        new GitProviderRequestError('oauth_app_restricted', 403),
        new GitProviderRequestError('unprocessable', 422),
    ];

    it.each(failures)('maps %p to a recorded failure', async (failure) => {
        const harness = makeHarness({
            handlers: {
                getRepository: () => {
                    throw failure;
                },
            },
        });

        const result = await runSync(harness);

        expect(result.outcome).toBe('settled');
        expect(result.result).toBe('failed');
        expect(result.reason).toBe(
            failure instanceof GitProviderRequestError ? failure.reason : 'failed',
        );
    });

    it('records a state failure while finishing as a warning, never as a throw', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 0,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });
        harness.states.finishSync.mockRejectedValue(new Error('proxy down'));

        const result = await runSync(harness);

        expect(result.outcome).toBe('settled');
        expect(result.result).toBe('up_to_date');
    });

    it('survives an Activity sink that throws', async () => {
        const harness = makeHarness({
            row: makeRow({ behindEventCount: 0 }),
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 1,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
            },
        });
        harness.activity.log.mockRejectedValue(new Error('sink down'));

        const result = await runSync(harness);

        expect(result.result).toBe('pull_request_opened');
        expect(result.events).toEqual([]);
    });

    it('survives hygiene and the licence request throwing (FR-30)', async () => {
        const harness = makeHarness({
            handlers: {
                getForkDivergence: () => ({
                    aheadBy: 0,
                    behindBy: 3,
                    upstreamHeadSha: SHA_B,
                    forkHeadSha: SHA_A,
                }),
                syncForkBranch: () => ({ outcome: 'fast_forwarded' }),
            },
        });
        harness.hygiene.apply.mockRejectedValue(new Error('hygiene down'));
        harness.licenses.request.mockRejectedValue(new Error('gate down'));

        const result = await runSync(harness);

        expect(result.result).toBe('fast_forwarded');
        expect(result.hygiene).toBeNull();
        expect(result.licenseRequested).toBe(false);
    });
});
