// The two sibling modules `AppWorksModule` imports pull in the whole TypeORM +
// facade + plugin-registry tree (exactly as `app-works.module.spec.ts` records for
// its own compiles). They are replaced with empty class shells at module scope so the
// container test at the end of this file exercises only what the module provides or
// mints itself: `AppSourceInitializerService` injects every collaborator those modules
// would supply `@Optional()`, so a shelled module is a supported graph and not a
// broken one.
jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GitOperationNotSupportedError } from '../../facades/git.facade';
import { GitProviderRequestError } from '@ever-works/plugin';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import { WorkRepository } from '../../database/repositories/work.repository';
import { WorksConfigService } from '../../works-config/services/works-config.service';
import { APP_LICENSE_SERVICE } from '../../app-runtime/app-license-gate';
import { APP_FORK_READY_HANDLER, type AppForkReadyOutcome } from '../app-fork-ready-handler.port';
import { AppWorksModule } from '../app-works.module';
import {
    APP_BLUEPRINT_APPLY_SERVICE,
    APP_PROVISIONING_SERVICE,
    APP_SOURCE_ACTIVITY_ACTION_TYPE,
    APP_SOURCE_ACTIVITY_EVENTS,
    APP_SOURCE_COMMIT_MAX_ATTEMPTS,
    APP_SOURCE_COMMIT_MESSAGE,
    APP_SOURCE_INITIALIZER_FAILURES,
    APP_SOURCE_INITIALIZER_FILE,
    APP_SOURCE_SETUP_BRANCH,
    APP_SOURCE_SETUP_PR_TITLE,
    AppSourceInitializerService,
    branchCarries,
    declaredKind,
    isNonFastForward,
    recordsBlueprint,
    relationOf,
    sameSourceBlock,
    serializeDocument,
    stripDangerousKeys,
} from '../app-source-initializer.service';

/**
 * APW-01 T15 — `AppSourceInitializerService`, clause by clause.
 *
 * The file is organised the way the task's **Test** line is, and every clause of it has
 * at least one case below:
 *
 *   1. the C32 fix (the `AppSpecService.initialize` call and what its absence answers);
 *   2. the Blueprint path (ACC-01-19) — no write, `blueprint_requested`, `applyInProgress`,
 *      `blueprint_<code>`, and the fall-through on an already-recorded Blueprint;
 *   3. the minimal path on a created fork (ACC-01-02) — one commit, no clone, keys kept,
 *      the two terminal documents, the `nonFastForward` retry and the absent capability;
 *   4. the minimal path on a link and an adopted fork (ACC-01-01, ACC-01-04) — the setup
 *      pull request, `createBranchFromSha` and never `createBranch`, branch reuse, the
 *      retry (ACC-01-17);
 *   5. the follow-ups (ACC-01-19, ACC-01-28);
 *   6. the Activity row (R-2, R-34);
 *   7. "the handler runs twice" — the task's Done-when;
 *   8. the wiring, on both sides of the package boundary this slice crosses.
 *
 * ## Two properties asserted on EVERY scenario rather than as examples
 *
 *   - **the facade spy records zero `cloneOrPull` calls** — and, on every non-created-fork
 *     relation, zero writes to the default branch;
 *   - **the state row is initialised**, which is C32: `AppSpecService.initialize` is
 *     called on the way into every path that reaches a repository.
 *
 * ## Why the fake is a tiny repository rather than a pile of `mockResolvedValue`s
 *
 * The idempotency clauses ("the handler twice produces exactly one commit / exactly one
 * open pull request") are about the SECOND run reading what the FIRST run wrote. A fake
 * whose `getFileContent` always answers `null` cannot express that, so `fakeGit()` keeps a
 * real per-branch head and file map: a commit moves the head and stores the file, and the
 * second run genuinely re-reads its own work.
 */

/** A uuid that exists in no database. */
const WORK_ID = '00000000-0000-4000-8000-000000000015';

/** The sha the default branch is at before anything happens. */
const HEAD_SHA = 'sha-head-0001';

/** The sha a commit of the source file produces. */
const COMMIT_SHA = 'sha-commit-0002';

/** A second commit, for the retry cases. */
const COMMIT_SHA_2 = 'sha-commit-0003';

const USER_ID = 'user-1';

/** The `.works/works.yml` a link's first run would write, as the handler composes it. */
function composedFor(relation: 'link' | 'fork' | 'private-copy'): string {
    return serializeDocument(
        {},
        relation === 'link'
            ? { relation, branch: 'main' }
            : {
                  relation,
                  upstream: { repo: 'upstream/widgets', defaultBranch: 'main' },
                  branch: 'main',
              },
    );
}

/** A Work row carrying an App source record, with only what a case cares about changed. */
function workRow(
    overrides: { record?: Record<string, unknown>; work?: Record<string, unknown> } = {},
) {
    const record = {
        url: 'https://github.com/member/widgets',
        owner: 'member',
        repo: 'widgets',
        type: 'app_fork',
        importedAt: new Date(),
        relatedRepositories: { website: { owner: 'member', repo: 'widgets' } },
        upstream: { owner: 'upstream', repo: 'widgets', defaultBranch: 'main' },
        createdByThisWork: true,
        ...(overrides.record ?? {}),
    };
    return {
        id: WORK_ID,
        userId: USER_ID,
        slug: 'widgets',
        owner: 'member',
        gitProvider: 'github',
        tenantId: null,
        organizationId: null,
        sourceRepository: record,
        ...(overrides.work ?? {}),
    };
}

interface FakeGitState {
    head: Record<string, string | undefined>;
    files: Record<string, string | undefined>;
    pulls: Array<{ number: number; state: string; head: string; url: string }>;
    seq: number;
}

/** A facade double that behaves like a small repository: heads move, files are stored. */
function fakeGit(state: FakeGitState) {
    const key = (ref: string, path: string) => `${ref}::${path}`;

    const commitFiles = jest.fn(
        async (
            _owner: string,
            _repo: string,
            input: {
                branch: string;
                baseSha: string;
                files: Array<{ path: string; content: string }>;
            },
        ) => {
            if (state.head[input.branch] !== input.baseSha) {
                throw Object.assign(new Error('nonFastForward'), { code: 'nonFastForward' });
            }
            state.seq += 1;
            const sha = state.seq === 1 ? COMMIT_SHA : COMMIT_SHA_2;
            for (const file of input.files) {
                // Reachable by BOTH the branch name and the commit sha, exactly as the
                // provider's `getContent(ref)` is: the handler reads by sha and commits
                // by branch, and a fake that only knew one of the two could not model
                // "the second run reads what the first run wrote".
                state.files[key(input.branch, file.path)] = file.content;
                state.files[key(sha, file.path)] = file.content;
            }
            state.head[input.branch] = sha;
            return { commitSha: sha };
        },
    );

    return {
        commitFiles,
        getLatestCommit: jest.fn(async (_owner: string, _repo: string, branch: string) => {
            const sha = state.head[branch];
            return sha ? { sha, message: 'm', author: { name: 'n', email: 'e' }, date: 'd' } : null;
        }),
        getFileContent: jest.fn(
            async (
                _owner: string,
                _repo: string,
                path: string,
                _options: unknown,
                ref?: string,
            ) => {
                const content = state.files[key(ref as string, path)];
                return content === undefined ? null : { content, encoding: 'utf-8' };
            },
        ),
        createBranchFromSha: jest.fn(
            async (_owner: string, _repo: string, name: string, sha: string) => {
                if (state.head[name] !== undefined) {
                    throw new GitProviderRequestError('conflict', 409);
                }
                state.head[name] = sha;
                return { name, commit: sha, isDefault: false };
            },
        ),
        // 🛑 `createBranch` resolves `heads/<fromRef>`, so a sha passed to it 404s. The
        // spec asserts it is NEVER called on this path; making it throw means a
        // regression is a red rather than a quietly-successful wrong call.
        createBranch: jest.fn(async () => {
            throw new Error('createBranch must never be used by the ready handler');
        }),
        listPullRequests: jest.fn(async () => state.pulls),
        createPullRequest: jest.fn(
            async (options: { title: string; head: string; base: string }) => {
                const pull = {
                    number: 7,
                    state: 'open',
                    head: options.head,
                    url: 'https://github.com/member/widgets/pull/7',
                };
                state.pulls.push(pull);
                return {
                    ...pull,
                    title: options.title,
                    base: options.base,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                };
            },
        ),
        // The one call this handler must never make (R-4). Present so the spy can prove
        // it was not called, rather than proving nothing by being absent.
        cloneOrPull: jest.fn(async () => {
            throw new Error('the ready handler must never clone');
        }),
    };
}

interface Harness {
    service: AppSourceInitializerService;
    git: ReturnType<typeof fakeGit>;
    state: FakeGitState;
    works: { findById: jest.Mock };
    states: { findByWorkId: jest.Mock };
    appSpec: { initialize: jest.Mock; hasValidAppSpec: jest.Mock };
    activity: { log: jest.Mock };
    blueprint: { request: jest.Mock };
    license: { request: jest.Mock };
    provisioning: { start: jest.Mock };
    run: () => Promise<AppForkReadyOutcome>;
    /** Every write the handler could make, so "writes nothing" is provable. */
    writes: () => Array<{ name: string; calls: number }>;
}

function harness(
    input: {
        work?: unknown;
        record?: Record<string, unknown>;
        head?: string | null;
        current?: string;
        pulls?: Array<{ number: number; state: string; head: string; url: string }>;
        trackedBranch?: string | null;
        commitFiles?: boolean;
        createBranchFromSha?: boolean;
        appSpec?: boolean;
        worksConfig?: boolean;
        activity?: boolean;
        blueprint?: boolean;
        license?: boolean;
        provisioning?: boolean;
        hasValidAppSpec?: boolean;
        hasValidAppSpecThrows?: boolean;
        startThrows?: boolean;
    } = {},
): Harness {
    const state: FakeGitState = {
        head: {},
        files: {},
        pulls: input.pulls ?? [],
        seq: 0,
    };
    const branch =
        input.trackedBranch === undefined || input.trackedBranch === null
            ? 'main'
            : input.trackedBranch;
    if (input.head !== null) {
        state.head[branch] = input.head ?? HEAD_SHA;
    }
    if (input.current !== undefined) {
        // Reachable by the branch AND by the head commit, because the handler reads
        // `getFileContent(..., ref: head.sha)` and commits by branch name.
        state.files[`${branch}::${APP_SOURCE_INITIALIZER_FILE}`] = input.current;
        if (state.head[branch]) {
            state.files[`${state.head[branch]}::${APP_SOURCE_INITIALIZER_FILE}`] = input.current;
        }
    }

    const git = fakeGit(state);
    const commitFilesMock = git.commitFiles;
    const createBranchFromShaMock = git.createBranchFromSha;
    if (input.commitFiles === false) {
        (git as unknown as Record<string, unknown>).commitFiles = undefined;
    }
    if (input.createBranchFromSha === false) {
        (git as unknown as Record<string, unknown>).createBranchFromSha = undefined;
    }

    const works = {
        findById: jest.fn(async () =>
            input.work === undefined ? workRow({ record: input.record }) : input.work,
        ),
    };
    const states = {
        findByWorkId: jest.fn(async () =>
            input.trackedBranch === null
                ? null
                : { dataDefaultBranch: input.trackedBranch ?? 'main' },
        ),
    };
    const appSpec = {
        initialize: jest.fn(async () => ({ workId: WORK_ID })),
        hasValidAppSpec: jest.fn(async () => {
            if (input.hasValidAppSpecThrows) {
                throw new Error('unreadable');
            }
            return input.hasValidAppSpec === true;
        }),
    };
    const activity = { log: jest.fn(async () => ({ id: 'activity-1' })) };
    const blueprint = { request: jest.fn(async () => ({ status: 'dispatched', runId: 'run-1' })) };
    const license = { request: jest.fn(async () => undefined) };
    const provisioning = {
        start: jest.fn(async () => {
            if (input.startThrows) {
                throw new Error('provisioning down');
            }
            return { started: true };
        }),
    };

    const service = new AppSourceInitializerService(
        works as never,
        states as never,
        git as never,
        (input.appSpec === false ? undefined : appSpec) as never,
        (input.worksConfig === false ? undefined : new WorksConfigService({} as never)) as never,
        (input.activity === false ? undefined : activity) as never,
        (input.blueprint === false ? undefined : blueprint) as never,
        (input.license === false ? undefined : license) as never,
        (input.provisioning === false ? undefined : provisioning) as never,
    );

    return {
        service,
        git,
        state,
        works,
        states,
        appSpec,
        activity,
        blueprint,
        license,
        provisioning,
        run: () => service.onDataRepositoryReady({ workId: WORK_ID }),
        writes: () => [
            { name: 'commitFiles', calls: commitFilesMock.mock.calls.length },
            { name: 'createBranchFromSha', calls: createBranchFromShaMock.mock.calls.length },
            { name: 'createBranch', calls: git.createBranch.mock.calls.length },
            { name: 'createPullRequest', calls: git.createPullRequest.mock.calls.length },
            { name: 'cloneOrPull', calls: git.cloneOrPull.mock.calls.length },
        ],
    };
}

/** Every write a scenario must be able to prove did NOT happen. */
const NO_PROVIDER_WRITES = [
    'commitFiles',
    'createBranchFromSha',
    'createBranch',
    'createPullRequest',
];

/** The `commitFiles` calls that targeted a branch. */
function commitsOn(git: ReturnType<typeof fakeGit>, branch: string): unknown[] {
    const calls = (git.commitFiles as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.filter((call) => (call[2] as { branch: string }).branch === branch);
}

describe('AppSourceInitializerService (APW-01 T15)', () => {
    /* ===================================================================== *
     * 1. The C32 fix — the App spec state row
     * ===================================================================== */

    describe('the C32 fix: the App spec state row is initialised', () => {
        it('calls AppSpecService.initialize with the Work and its tracked branch', async () => {
            const h = harness();

            await h.run();

            expect(h.appSpec.initialize).toHaveBeenCalledTimes(1);
            expect(h.appSpec.initialize).toHaveBeenCalledWith(WORK_ID, 'main', {
                tenantId: null,
                organizationId: null,
            });
        });

        it('uses the epic’s own state row for the tracked branch, not a guess', async () => {
            const h = harness({ trackedBranch: 'develop' });

            await h.run();

            expect(h.appSpec.initialize).toHaveBeenCalledWith(
                WORK_ID,
                'develop',
                expect.anything(),
            );
            // The compose step records the same branch it initialised the row with.
            const committed = (h.git.commitFiles.mock.calls[0] as unknown[])[2] as {
                branch: string;
                files: Array<{ content: string }>;
            };
            expect(committed.branch).toBe('develop');
            expect(committed.files[0].content).toContain('branch: develop');
        });

        it('falls back to the upstream’s default branch, then `main`', async () => {
            const withUpstream = harness({ record: { upstream: undefined }, trackedBranch: null });
            await withUpstream.run();
            // The record's own `type: app_fork` has no upstream in that case, so the
            // documented `main` fallback answers.
            expect(withUpstream.appSpec.initialize).toHaveBeenCalledWith(
                WORK_ID,
                'main',
                expect.anything(),
            );
        });

        it('initialises the row on EVERY invocation — it is the retry’s idempotent door', async () => {
            const h = harness();

            await h.run();
            await h.run();

            expect(h.appSpec.initialize).toHaveBeenCalledTimes(2);
        });

        it('answers failed/spec_state_unavailable — and touches no repository — with no AppSpecService', async () => {
            const h = harness({ appSpec: false });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.specStateUnavailable,
            });
            for (const write of h.writes()) {
                expect(write).toEqual({ name: write.name, calls: 0 });
            }
            // The failed outcome is still reported: silence is the one answer C32 forbids.
            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: APP_SOURCE_ACTIVITY_EVENTS.failed,
                    details: { reason: APP_SOURCE_INITIALIZER_FAILURES.specStateUnavailable },
                }),
            );
        });

        it('answers a NAMED refusal for every absent collaborator, never a silent success', async () => {
            const noWork = harness({ work: null });
            await expect(noWork.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.workNotFound,
            });

            const noRepo = harness({
                work: workRow({
                    record: { relatedRepositories: undefined, owner: null, repo: null },
                    work: { owner: null, slug: null },
                }),
            });
            await expect(noRepo.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.repositoryUnresolved,
            });
        });
    });

    /* ===================================================================== *
     * 2. The Blueprint path (ACC-01-19)
     * ===================================================================== */

    describe('the Blueprint path (ACC-01-19)', () => {
        const BLUEPRINT = { blueprintId: 'umami', blueprintMatchSource: 'manifest' };

        it('requests the apply, writes NOTHING, and answers blueprint_requested', async () => {
            const h = harness({
                record: BLUEPRINT,
                commitFiles: false,
                createBranchFromSha: false,
            });

            const outcome = await h.run();

            expect(outcome).toEqual({ result: 'blueprint_requested' });
            expect(h.blueprint.request).toHaveBeenCalledTimes(1);
            expect(h.blueprint.request).toHaveBeenCalledWith(WORK_ID, 'umami', {
                userId: USER_ID,
                matchSource: 'manifest',
                confirmForkMatch: false,
            });
            // "this handler writes nothing first, so the two can never race"
            // (`plan.md:831-832`) — asserted with the capability REMOVED, so a write
            // attempt would be a failed outcome rather than a silent pass.
            for (const name of NO_PROVIDER_WRITES) {
                expect(h.writes().find((write) => write.name === name)).toEqual({
                    name,
                    calls: 0,
                });
            }
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
        });

        it('defaults the match source to `explicit` when the record names none', async () => {
            const h = harness({ record: { blueprintId: 'umami' } });

            await h.run();

            expect(h.blueprint.request).toHaveBeenCalledWith(WORK_ID, 'umami', {
                userId: USER_ID,
                confirmForkMatch: false,
            });
        });

        it('writes one Activity row naming the Blueprint', async () => {
            const h = harness({ record: BLUEPRINT });

            await h.run();

            expect(h.activity.log).toHaveBeenCalledTimes(1);
            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: APP_SOURCE_ACTIVITY_ACTION_TYPE,
                    action: APP_SOURCE_ACTIVITY_EVENTS.forked,
                    details: { blueprint: true, setupPullRequest: false },
                }),
            );
        });

        it('falls through to the minimal path when the file already records the Blueprint and source', async () => {
            const h = harness({
                record: BLUEPRINT,
                current: [
                    'version: 2',
                    'kind: app',
                    'spec:',
                    '  blueprint:',
                    '    id: umami',
                    '  source:',
                    '    relation: fork',
                    '    branch: main',
                    '    upstream:',
                    '      repo: upstream/widgets',
                    '      defaultBranch: main',
                    '',
                ].join('\n'),
            });

            const outcome = await h.run();

            expect(outcome).toEqual({ result: 'unchanged' });
            expect(h.blueprint.request).not.toHaveBeenCalled();
            expect(commitsOn(h.git, 'main')).toHaveLength(0);
        });

        it('still takes the Blueprint path when the file records the Blueprint WITHOUT the source', async () => {
            const h = harness({
                record: BLUEPRINT,
                current: [
                    'version: 2',
                    'kind: app',
                    'spec:',
                    '  blueprint:',
                    '    id: umami',
                    '',
                ].join('\n'),
            });

            const outcome = await h.run();

            expect(outcome).toEqual({ result: 'blueprint_requested' });
            expect(h.blueprint.request).toHaveBeenCalledTimes(1);
        });

        it('returns blueprint_requested for an applyInProgress refusal', async () => {
            const h = harness({ record: BLUEPRINT });
            h.blueprint.request.mockResolvedValue({ status: 'refused', code: 'applyInProgress' });

            await expect(h.run()).resolves.toEqual({ result: 'blueprint_requested' });
        });

        it('returns blueprint_requested when applyInProgress arrives as a THROWN HttpException', async () => {
            const h = harness({ record: BLUEPRINT });
            h.blueprint.request.mockRejectedValue(
                new ConflictException({ code: 'applyInProgress' }),
            );

            await expect(h.run()).resolves.toEqual({ result: 'blueprint_requested' });
        });

        it('answers failed/blueprint_<code> for every other refusal', async () => {
            for (const code of ['blueprintNotFound', 'forkMatchNeedsConfirmation', 'noUpgrade']) {
                const h = harness({ record: BLUEPRINT });
                h.blueprint.request.mockResolvedValue({ status: 'refused', code });

                await expect(h.run()).resolves.toEqual({
                    result: 'failed',
                    reason: `blueprint_${code}`,
                });
                for (const name of NO_PROVIDER_WRITES) {
                    expect(h.writes().find((write) => write.name === name)?.calls).toBe(0);
                }
            }
        });

        it('answers failed/blueprint_unavailable when no apply service is bound', async () => {
            const h = harness({ record: BLUEPRINT, blueprint: false });

            await expect(h.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.blueprintUnavailable,
            });
            for (const name of NO_PROVIDER_WRITES) {
                expect(h.writes().find((write) => write.name === name)?.calls).toBe(0);
            }
        });

        it('treats a codeless throw as a fault, never as an acceptance', async () => {
            const h = harness({ record: BLUEPRINT });
            h.blueprint.request.mockRejectedValue(new Error('engine down'));

            await expect(h.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.blueprintRequestFailed,
            });
        });
    });

    /* ===================================================================== *
     * 3. The minimal path — a created fork (ACC-01-02)
     * ===================================================================== */

    describe('the minimal path on a created fork (ACC-01-02)', () => {
        it('lands exactly ONE commit on the default branch and never clones', async () => {
            const h = harness();

            const outcome = await h.run();

            expect(outcome).toEqual({ result: 'initialized' });
            expect(commitsOn(h.git, 'main')).toHaveLength(1);
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
            const input = (commitsOn(h.git, 'main')[0] as unknown[])[2] as {
                baseSha: string;
                message: string;
                files: Array<{ path: string; content: string; encoding: string }>;
            };
            expect(input.baseSha).toBe(HEAD_SHA);
            expect(input.message).toBe(APP_SOURCE_COMMIT_MESSAGE);
            expect(input.files).toHaveLength(1);
            expect(input.files[0]).toMatchObject({
                path: APP_SOURCE_INITIALIZER_FILE,
                encoding: 'utf-8',
            });
            // No branch, no pull request: the repository is this App Work's own.
            expect(h.git.createBranchFromSha).not.toHaveBeenCalled();
            expect(h.git.createBranch).not.toHaveBeenCalled();
            expect(h.git.createPullRequest).not.toHaveBeenCalled();
        });

        it('writes version 2, kind app and the source block the relation fixes', async () => {
            const h = harness();

            await h.run();

            const content = (
                (commitsOn(h.git, 'main')[0] as unknown[])[2] as {
                    files: Array<{ content: string }>;
                }
            ).files[0].content;
            expect(content).toContain('version: 2');
            expect(content).toContain('kind: app');
            expect(content).toContain('source:');
            expect(content).toContain('relation: fork');
            expect(content).toContain('repo: upstream/widgets');
            expect(content).toContain('branch: main');
        });

        it('preserves every other key the file already had', async () => {
            const h = harness({
                current: [
                    'version: 1',
                    'name: My Widgets',
                    'initial_prompt: keep me',
                    'model: gpt-5',
                    'providers:',
                    '  ai: openai',
                    'spec:',
                    '  custom: true',
                    '',
                ].join('\n'),
            });

            await h.run();

            const content = (
                (commitsOn(h.git, 'main')[0] as unknown[])[2] as {
                    files: Array<{ content: string }>;
                }
            ).files[0].content;
            expect(content).toContain('name: My Widgets');
            expect(content).toContain('initial_prompt: keep me');
            expect(content).toContain('model: gpt-5');
            expect(content).toContain('ai: openai');
            expect(content).toContain('custom: true');
            expect(content).toContain('version: 2');
        });

        it('strips prototype-polluting keys instead of carrying them into the commit', async () => {
            const h = harness({
                current: [
                    'version: 1',
                    'name: Widgets',
                    'constructor: hostile',
                    'spec:',
                    '  prototype: hostile',
                    '  custom: true',
                    '',
                ].join('\n'),
            });

            await h.run();

            const content = (
                (commitsOn(h.git, 'main')[0] as unknown[])[2] as {
                    files: Array<{ content: string }>;
                }
            ).files[0].content;
            expect(content).not.toContain('hostile');
            expect(content).toContain('custom: true');
        });

        it('answers unchanged — and commits nothing — when the file already records it', async () => {
            const h = harness({ current: composedFor('fork') });

            const outcome = await h.run();

            expect(outcome).toEqual({ result: 'unchanged' });
            expect(h.git.commitFiles).not.toHaveBeenCalled();
        });

        it('refuses an unparseable file, untouched', async () => {
            const h = harness({ current: 'name: [unclosed\n  bad: : :' });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.worksYmlUnparseable,
            });
            expect(h.git.commitFiles).not.toHaveBeenCalled();
        });

        it('refuses a file that declares another kind, untouched', async () => {
            const h = harness({ current: ['version: 2', 'kind: blog', ''].join('\n') });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.worksYmlOtherKind,
            });
            expect(h.git.commitFiles).not.toHaveBeenCalled();
        });

        it('refuses `spec.kind` too — the loader reads it first', async () => {
            const h = harness({
                current: ['version: 2', 'kind: app', 'spec:', '  kind: directory', ''].join('\n'),
            });

            await expect(h.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.worksYmlOtherKind,
            });
        });

        it('answers failed/head_unreadable when the default branch has no commit', async () => {
            const h = harness({ head: null });

            await expect(h.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.headUnreadable,
            });
        });

        it('answers failed/provider_unsupported when commitFiles is absent — never a clone', async () => {
            const h = harness({ commitFiles: false });

            await expect(h.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
            });
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
        });

        it('re-reads head, retries a non-fast-forward, then fails push_rejected', async () => {
            const h = harness();
            // Every attempt refuses: the branch head never matches the baseSha handed in.
            h.git.commitFiles.mockImplementation(async () => {
                throw Object.assign(new Error('nonFastForward'), { code: 'nonFastForward' });
            });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.pushRejected,
            });
            expect(h.git.commitFiles).toHaveBeenCalledTimes(APP_SOURCE_COMMIT_MAX_ATTEMPTS);
            // The retry re-reads head: three attempts, and the reads before them.
            expect(h.git.getLatestCommit.mock.calls.length).toBeGreaterThanOrEqual(
                APP_SOURCE_COMMIT_MAX_ATTEMPTS,
            );
        });

        it('retries a non-fast-forward once and succeeds on the fresh head', async () => {
            const h = harness();
            h.git.commitFiles.mockImplementationOnce(async () => {
                h.state.head.main = 'sha-head-moved';
                throw new GitProviderRequestError('conflict', 409);
            });

            const outcome = await h.run();

            expect(outcome.result).toBe('initialized');
            expect(h.git.commitFiles).toHaveBeenCalledTimes(2);
            const second = (h.git.commitFiles.mock.calls[1] as unknown[])[2] as { baseSha: string };
            expect(second.baseSha).toBe('sha-head-moved');
        });
    });

    /* ===================================================================== *
     * 4. The minimal path — a link and an adopted fork (ACC-01-01, ACC-01-04)
     * ===================================================================== */

    describe('the minimal path on a link (ACC-01-01)', () => {
        const LINK = {
            type: 'app_link',
            createdByThisWork: false,
            upstream: undefined,
        };

        it('cuts ever-works/app-setup from the HEAD SHA and never touches the default branch', async () => {
            const h = harness({ record: LINK });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'waiting_for_setup_pr',
                setupPullRequestUrl: 'https://github.com/member/widgets/pull/7',
                setupPullRequestNumber: 7,
            });
            // ACC-01-01: one setup pull request and NOTHING pushed to the default branch.
            expect(commitsOn(h.git, 'main')).toHaveLength(0);
            expect(commitsOn(h.git, APP_SOURCE_SETUP_BRANCH)).toHaveLength(1);
            // 🛑 `createBranch` resolves `heads/<fromRef>`, so a sha passed to it 404s.
            expect(h.git.createBranch).not.toHaveBeenCalled();
            expect(h.git.createBranchFromSha).toHaveBeenCalledTimes(1);
            const args = h.git.createBranchFromSha.mock.calls[0] as unknown[];
            expect(args[2]).toBe(APP_SOURCE_SETUP_BRANCH);
            // …whose 4th argument equals the mocked `getLatestCommit` sha.
            expect(args[3]).toBe(HEAD_SHA);
            // …followed by `commitFiles` on that branch with the SAME baseSha.
            const commit = (h.git.commitFiles.mock.calls[0] as unknown[])[2] as {
                branch: string;
                baseSha: string;
            };
            expect(commit.branch).toBe(APP_SOURCE_SETUP_BRANCH);
            expect(commit.baseSha).toBe(HEAD_SHA);
            // One pull request, from the setup branch onto the default branch.
            expect(h.git.createPullRequest).toHaveBeenCalledTimes(1);
            expect(h.git.createPullRequest.mock.calls[0][0]).toMatchObject({
                head: APP_SOURCE_SETUP_BRANCH,
                base: 'main',
                title: APP_SOURCE_SETUP_PR_TITLE,
            });
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
        });

        it('records the link relation and writes app.source.linked', async () => {
            const h = harness({ record: LINK });

            await h.run();

            const content = (
                (h.git.commitFiles.mock.calls[0] as unknown[])[2] as {
                    files: Array<{ content: string }>;
                }
            ).files[0].content;
            expect(content).toContain('relation: link');
            // Schema R13: `upstream` is forbidden for a link.
            expect(content).not.toContain('upstream:');
            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: APP_SOURCE_ACTIVITY_ACTION_TYPE,
                    action: APP_SOURCE_ACTIVITY_EVENTS.linked,
                    details: { blueprint: false, setupPullRequest: true },
                }),
            );
        });

        it('reuses an existing branch with the BRANCH’s own head as baseSha', async () => {
            const h = harness({ record: LINK });
            // The branch already exists at a different commit.
            h.state.head[APP_SOURCE_SETUP_BRANCH] = 'sha-setup-existing';
            h.git.createBranchFromSha.mockRejectedValue(
                new GitProviderRequestError('conflict', 409),
            );

            const outcome = await h.run();

            expect(outcome.result).toBe('waiting_for_setup_pr');
            const commit = (h.git.commitFiles.mock.calls[0] as unknown[])[2] as { baseSha: string };
            expect(commit.baseSha).toBe('sha-setup-existing');
        });

        it('answers failed/provider_unsupported — and opens NO pull request — without createBranchFromSha', async () => {
            const h = harness({ record: LINK, createBranchFromSha: false });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
            });
            expect(h.git.createPullRequest).not.toHaveBeenCalled();
            expect(h.git.commitFiles).not.toHaveBeenCalled();
            expect(commitsOn(h.git, 'main')).toHaveLength(0);
        });

        it('answers failed/provider_unsupported when the provider refuses the branch capability', async () => {
            const h = harness({ record: LINK });
            h.git.createBranchFromSha.mockRejectedValue(
                new GitOperationNotSupportedError('createBranchFromSha', 'github'),
            );

            await expect(h.run()).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.providerUnsupported,
            });
            expect(h.git.createPullRequest).not.toHaveBeenCalled();
        });

        it('reuses the open setup pull request on a re-invocation (ACC-01-17)', async () => {
            const h = harness({ record: LINK });

            await h.run();
            const second = await h.run();

            expect(second.result).toBe('waiting_for_setup_pr');
            expect(h.git.createPullRequest).toHaveBeenCalledTimes(1);
            expect(h.state.pulls).toHaveLength(1);
            // …and the branch already carries the document, so nothing is committed twice.
            expect(commitsOn(h.git, APP_SOURCE_SETUP_BRANCH)).toHaveLength(1);
        });
    });

    describe('the minimal path on an adopted fork (ACC-01-04)', () => {
        it('opens a setup pull request and never commits to the default branch', async () => {
            const h = harness({ record: { createdByThisWork: false } });

            const outcome = await h.run();

            expect(outcome).toEqual({
                result: 'waiting_for_setup_pr',
                setupPullRequestUrl: 'https://github.com/member/widgets/pull/7',
                setupPullRequestNumber: 7,
            });
            expect(commitsOn(h.git, 'main')).toHaveLength(0);
            expect(commitsOn(h.git, APP_SOURCE_SETUP_BRANCH)).toHaveLength(1);
            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ action: APP_SOURCE_ACTIVITY_EVENTS.forked }),
            );
        });

        it('records a private copy as app.source.copied', async () => {
            const h = harness({ record: { type: 'app_private_copy' } });

            await h.run();

            expect(
                (
                    (h.git.commitFiles.mock.calls[0] as unknown[])[2] as {
                        files: Array<{ content: string }>;
                    }
                ).files[0].content,
            ).toContain('relation: private-copy');
            expect(h.activity.log).toHaveBeenCalledTimes(1);
            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ action: APP_SOURCE_ACTIVITY_EVENTS.copied }),
            );
        });
    });

    /* ===================================================================== *
     * 5. The follow-ups (ACC-01-19, ACC-01-28)
     * ===================================================================== */

    describe('the follow-ups', () => {
        it('requests the licence and starts provisioning once while the file is still source-only', async () => {
            const h = harness();

            await h.run();

            expect(h.license.request).toHaveBeenCalledTimes(1);
            expect(h.license.request).toHaveBeenCalledWith(WORK_ID);
            expect(h.appSpec.hasValidAppSpec).toHaveBeenCalledWith(WORK_ID, COMMIT_SHA);
            expect(h.provisioning.start).toHaveBeenCalledTimes(1);
            expect(h.provisioning.start).toHaveBeenCalledWith({
                workId: WORK_ID,
                trigger: 'auto-create',
            });
        });

        it('starts provisioning once on the post-merge re-invocation of a source-only file', async () => {
            const h = harness({ current: composedFor('fork') });
            // `unchanged` ⇒ the re-read default-branch head is what the gate reads.
            h.appSpec.hasValidAppSpec.mockResolvedValue(false);

            const outcome = await h.run();

            expect(outcome).toEqual({ result: 'unchanged' });
            expect(h.provisioning.start).toHaveBeenCalledTimes(1);
            expect(h.appSpec.hasValidAppSpec).toHaveBeenCalledWith(WORK_ID, HEAD_SHA);
        });

        it('does NOT start provisioning on a file that already holds a valid full spec', async () => {
            const h = harness({ current: composedFor('fork'), hasValidAppSpec: true });

            await h.run();

            expect(h.provisioning.start).not.toHaveBeenCalled();
            // …while the licence request still runs.
            expect(h.license.request).toHaveBeenCalledTimes(1);
        });

        it('DOES start provisioning for a full spec that still has errors', async () => {
            // `hasValidAppSpec` answers for the file that has errors with `false`; the
            // handler's job is only to read that answer, never to re-validate.
            const h = harness({ hasValidAppSpec: false });

            await h.run();

            expect(h.provisioning.start).toHaveBeenCalledTimes(1);
        });

        it('fails CLOSED — no start — when hasValidAppSpec itself throws', async () => {
            const h = harness({ hasValidAppSpecThrows: true });

            await h.run();

            expect(h.provisioning.start).not.toHaveBeenCalled();
        });

        it('never fails the hand-off when provisioning throws', async () => {
            const h = harness({ startThrows: true });

            await expect(h.run()).resolves.toEqual({ result: 'initialized' });
        });

        it('runs no follow-up while the setup pull request is unmerged', async () => {
            const h = harness({ record: { type: 'app_link', createdByThisWork: false } });

            const outcome = await h.run();

            expect(outcome.result).toBe('waiting_for_setup_pr');
            expect(h.license.request).not.toHaveBeenCalled();
            expect(h.provisioning.start).not.toHaveBeenCalled();
            expect(h.appSpec.hasValidAppSpec).not.toHaveBeenCalled();
        });

        it('runs no follow-up on a terminal failure', async () => {
            const h = harness({ current: 'kind: blog' });

            await h.run();

            expect(h.license.request).not.toHaveBeenCalled();
            expect(h.provisioning.start).not.toHaveBeenCalled();
        });

        describe('sourceRepository.autoProvision === false (ACC-01-28)', () => {
            it('skips the start on the created-fork path while the licence request still runs', async () => {
                const h = harness({ record: { autoProvision: false } });

                await h.run();

                expect(h.provisioning.start).not.toHaveBeenCalled();
                expect(h.license.request).toHaveBeenCalledTimes(1);
                // The Activity row is the same `app.source.*` row.
                expect(h.activity.log).toHaveBeenCalledWith(
                    expect.objectContaining({ action: APP_SOURCE_ACTIVITY_EVENTS.forked }),
                );
            });

            it('is read from the Work row on the post-merge re-invocation too', async () => {
                const h = harness({
                    record: { autoProvision: false },
                    current: composedFor('fork'),
                });

                const outcome = await h.run();

                expect(outcome).toEqual({ result: 'unchanged' });
                expect(h.provisioning.start).not.toHaveBeenCalled();
                expect(h.license.request).toHaveBeenCalledTimes(1);
            });
        });
    });

    /* ===================================================================== *
     * 6. The Activity row (R-2, R-34)
     * ===================================================================== */

    describe('the Activity row', () => {
        it('writes exactly one row per outcome', async () => {
            const ok = harness();
            await ok.run();
            expect(ok.activity.log).toHaveBeenCalledTimes(1);

            const failed = harness({ current: 'kind: blog' });
            await failed.run();
            expect(failed.activity.log).toHaveBeenCalledTimes(1);
        });

        it('records app.source.failed with the reason code', async () => {
            const h = harness({ current: 'kind: blog' });

            await h.run();

            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: APP_SOURCE_ACTIVITY_ACTION_TYPE,
                    action: APP_SOURCE_ACTIVITY_EVENTS.failed,
                    status: 'failed',
                    details: { reason: APP_SOURCE_INITIALIZER_FAILURES.worksYmlOtherKind },
                }),
            );
        });

        it('carries { blueprint, setupPullRequest } — both booleans — on a success', async () => {
            const h = harness();

            await h.run();

            expect(h.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: { blueprint: false, setupPullRequest: false },
                }),
            );
        });

        it('contains no body text anywhere in the payload', async () => {
            const body = 'SECRET-BODY-MARKER: do not log me';
            const h = harness({
                current: ['version: 1', `initial_prompt: ${body}`, ''].join('\n'),
            });

            await h.run();

            const serialised = JSON.stringify(h.activity.log.mock.calls);
            expect(serialised).not.toContain('SECRET-BODY-MARKER');
            expect(serialised).not.toContain(body);
        });

        it('never fails the hand-off when the Activity write throws', async () => {
            const h = harness();
            h.activity.log.mockRejectedValue(new Error('activity down'));

            await expect(h.run()).resolves.toEqual({ result: 'initialized' });
        });

        it('is skipped — and the hand-off still succeeds — with no ActivityLogService', async () => {
            const h = harness({ activity: false });

            await expect(h.run()).resolves.toEqual({ result: 'initialized' });
        });
    });

    /* ===================================================================== *
     * 7. The handler twice — the task's Done-when
     * ===================================================================== */

    describe('running the handler twice on the same Work', () => {
        it('produces exactly ONE commit on a created fork', async () => {
            const h = harness();

            const first = await h.run();
            const second = await h.run();

            expect(first).toEqual({ result: 'initialized' });
            expect(second).toEqual({ result: 'unchanged' });
            expect(commitsOn(h.git, 'main')).toHaveLength(1);
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
        });

        it('produces exactly ONE open setup pull request on a link', async () => {
            const h = harness({ record: { type: 'app_link', createdByThisWork: false } });

            const first = await h.run();
            const second = await h.run();

            expect(first.result).toBe('waiting_for_setup_pr');
            expect(second).toEqual(first);
            expect(h.state.pulls).toHaveLength(1);
            expect(commitsOn(h.git, APP_SOURCE_SETUP_BRANCH)).toHaveLength(1);
            expect(commitsOn(h.git, 'main')).toHaveLength(0);
            expect(h.git.cloneOrPull).not.toHaveBeenCalled();
        });
    });

    /* ===================================================================== *
     * 8. The wiring — both sides of the package boundary
     * ===================================================================== */

    describe('the wiring', () => {
        it('provides and exports the handler from the agent AppWorksModule', () => {
            const providers = (Reflect.getMetadata('providers', AppWorksModule) as unknown[]) ?? [];
            const exports = (Reflect.getMetadata('exports', AppWorksModule) as unknown[]) ?? [];

            expect(providers).toContain(AppSourceInitializerService);
            expect(exports).toContain(AppSourceInitializerService);
        });

        it('compiles in a bare graph — every collaborator is optional by construction', async () => {
            const moduleRef = await Test.createTestingModule({ imports: [AppWorksModule] })
                .overrideProvider(getRepositoryToken(WorkUpstreamState))
                .useValue({ findOne: jest.fn().mockResolvedValue(null) })
                .overrideProvider(DistributedTaskLockService)
                .useValue({ runExclusive: jest.fn(), isLocked: jest.fn() })
                .compile();

            const service = moduleRef.get(AppSourceInitializerService);
            expect(service).toBeInstanceOf(AppSourceInitializerService);
            // No collaborator reached it, so the handler answers its NAMED refusal rather
            // than reporting a hand-off that never touched a repository.
            await expect(service.onDataRepositoryReady({ workId: WORK_ID })).resolves.toEqual({
                result: 'failed',
                reason: APP_SOURCE_INITIALIZER_FAILURES.dependenciesUnavailable,
            });

            await moduleRef.close();
        });

        /**
         * The API-side module and the worker module are two files in two other packages, so
         * the compiler cannot check them together. They are read as text — the idiom
         * `app-fork-readiness-wiring.spec.ts:278-326` uses for the same reason — with every
         * whitespace character removed, so a `prettier --write` cannot turn a real
         * assertion red.
         */
        const apiModule = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                '..',
                'apps',
                'api',
                'src',
                'app-works',
                'app-works.module.ts',
            ),
            'utf8',
        );
        const controller = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                '..',
                'apps',
                'api',
                'src',
                'trigger',
                'trigger-internal.controller.ts',
            ),
            'utf8',
        );
        const worker = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                'tasks',
                'src',
                'trigger',
                'worker',
                'modules',
                'trigger-worker.module.ts',
            ),
            'utf8',
        );
        const dense = (source: string) => source.replace(/\s+/g, '');

        it('declares the wired copy in the API module and binds the token with useExisting', () => {
            // Without the provider AND the import, the bound handler would resolve the
            // agent module's copy — whose `AppSpecService` is undefined — and C32 would
            // stay open behind a binding that looks correct.
            expect(dense(apiModule)).toContain(
                "import{AppSpecModule}from'@ever-works/agent/app-spec'",
            );
            expect(dense(apiModule)).toContain(
                "import{WorksConfigService}from'@ever-works/agent/works-config'",
            );
            expect(dense(apiModule)).toContain('AppSpecModule,');
            expect(dense(apiModule)).toContain('WorksConfigService,');
            expect(dense(apiModule)).toContain('AppSourceInitializerService,');
            expect(dense(apiModule)).toContain(
                '{provide:APP_FORK_READY_HANDLER,useExisting:AppSourceInitializerService}',
            );
        });

        it('publishes the handler on the internal RPC channel, with only @Optional() after it', () => {
            expect(dense(controller)).toContain(
                'privatereadonlyappSourceInitializerService?:AppSourceInitializerService',
            );
            expect(dense(controller)).toContain(
                'AppSourceInitializerService:this.appSourceInitializerService',
            );
            // The arity rule: the parameter was appended LAST and `@Optional()`, so every
            // positional `new TriggerInternalController(...)` in the specs keeps compiling.
            // This pin used to read "the handler is the final `@Optional()`". It stopped
            // being the last parameter when APW-05 T21 (`AppBuildSweepService`) and APW-06
            // §5.1 (`AppDeployBuildSourceAdapter`) were appended after it under the same
            // rule, so the pin now asserts the rule itself: the handler is `@Optional()`, and
            // so is EVERY constructor parameter declared after it. A required parameter
            // appended after it, or the handler losing `@Optional()`, still fails here.
            const start = controller.indexOf('constructor(') + 'constructor('.length;
            const parameterList = controller
                .slice(start, controller.indexOf(') {}', start))
                // Comments name `@Optional()` and carry commas and parentheses; only the
                // declarations count.
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');
            // One entry per parameter: split at commas outside any (), [], {} or <>, so a
            // generic type or an `@Inject(forwardRef(() => X))` stays in one piece.
            const parameters: string[] = [];
            let depth = 0;
            let current = '';
            for (let i = 0; i < parameterList.length; i++) {
                const ch = parameterList[i];
                if ('([{<'.includes(ch)) depth++;
                else if (')]}'.includes(ch) || (ch === '>' && parameterList[i - 1] !== '='))
                    depth--;
                if (ch === ',' && depth === 0) {
                    parameters.push(dense(current));
                    current = '';
                } else {
                    current += ch;
                }
            }
            parameters.push(dense(current));
            const declared = parameters.filter(Boolean);

            const handlerAt = declared.indexOf(
                '@Optional()privatereadonlyappSourceInitializerService?:AppSourceInitializerService',
            );
            expect(handlerAt).toBeGreaterThan(-1);
            for (const later of declared.slice(handlerAt + 1)) {
                expect(later).toContain('@Optional()');
            }
        });

        it('does NOT add onDataRepositoryReady to the retry-safe remote methods', () => {
            const apiClient = readFileSync(
                join(
                    __dirname,
                    '..',
                    '..',
                    '..',
                    '..',
                    'tasks',
                    'src',
                    'trigger',
                    'worker',
                    'services',
                    'trigger-internal-api.client.ts',
                ),
                'utf8',
            );
            expect(apiClient).not.toContain('onDataRepositoryReady');
            expect(controller).not.toContain("'onDataRepositoryReady'");
        });

        it('binds the token in the WORKER to a remote proxy — never the class', () => {
            expect(dense(worker)).toContain(
                "provide:APP_FORK_READY_HANDLER,useFactory:(apiClient:TriggerInternalApiClient)=>createRemoteProxy(apiClient,'AppSourceInitializerService')",
            );
            // 🛑 The worker owns no database and no ActivityLogService: providing the class
            // or importing AppWorksModule there is the failure this asserts against.
            expect(worker).not.toContain('AppSourceInitializerService,');
            expect(worker).not.toContain('AppSourceInitializerService }');
            expect(worker).not.toContain(
                "from '@ever-works/agent/app-works/app-source-initializer.service'",
            );
            const appWorksImports = worker.match(
                /import\s*\{[^}]*\}\s*from\s*'@ever-works\/agent\/app-works'/g,
            );
            expect(appWorksImports ?? []).toHaveLength(1);
            expect(appWorksImports?.[0]).toContain('APP_FORK_READY_HANDLER');
            expect(appWorksImports?.[0]).not.toContain('AppWorksModule');
        });

        it('names the same three DI tokens the other epics own', () => {
            expect(typeof APP_BLUEPRINT_APPLY_SERVICE).toBe('symbol');
            expect(typeof APP_PROVISIONING_SERVICE).toBe('symbol');
            // R-26: the licence request REUSES APW-03's own token rather than declaring a
            // second Symbol of the same name.
            expect(typeof APP_LICENSE_SERVICE).toBe('symbol');
            expect(APP_LICENSE_SERVICE.description).toBe('APP_LICENSE_SERVICE');
        });
    });

    /* ===================================================================== *
     * 9. The pure helpers
     * ===================================================================== */

    describe('the pure helpers', () => {
        it('reads the relation back from the persisted source type', () => {
            expect(relationOf({ type: 'app_fork' } as never)).toBe('fork');
            expect(relationOf({ type: 'app_private_copy' } as never)).toBe('private-copy');
            expect(relationOf({ type: 'app_link' } as never)).toBe('link');
            expect(relationOf({ type: undefined } as never)).toBe('link');
        });

        it('recognises the same Blueprint only together with a source block', () => {
            const both = [
                'version: 2',
                'kind: app',
                'spec:',
                '  blueprint:',
                '    id: x',
                '  source:',
                '    relation: link',
                '',
            ].join('\n');
            const blueprintOnly = [
                'version: 2',
                'kind: app',
                'spec:',
                '  blueprint:',
                '    id: x',
                '',
            ].join('\n');

            expect(recordsBlueprint(both, 'x')).toBe(true);
            expect(recordsBlueprint(blueprintOnly, 'x')).toBe(false);
            expect(recordsBlueprint(both, 'y')).toBe(false);
            expect(recordsBlueprint('not: [valid', 'x')).toBe(false);
        });

        it('compares source blocks structurally, not by key order', () => {
            expect(
                sameSourceBlock(
                    { relation: 'link', branch: 'main' },
                    { branch: 'main', relation: 'link' },
                ),
            ).toBe(true);
            expect(
                sameSourceBlock(
                    { relation: 'link', branch: 'main' },
                    { branch: 'main', relation: 'link', upstream: { repo: 'a/b' } },
                ),
            ).toBe(false);
        });

        it('reads the declared kind from `spec.kind` first, then the root', () => {
            expect(declaredKind({ kind: 'app' })).toBe('app');
            expect(declaredKind({ kind: 'app', spec: { kind: 'blog' } })).toBe('blog');
            expect(declaredKind({})).toBeNull();
        });

        it('drops dangerous own keys from a COPY, leaving the input untouched', () => {
            const hostile = JSON.parse('{"__proto__": {"polluted": true}, "keep": 1}') as Record<
                string,
                unknown
            >;

            const clean = stripDangerousKeys(hostile) as Record<string, unknown>;

            expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
            expect(Object.prototype.hasOwnProperty.call(clean, '__proto__')).toBe(false);
            expect(clean.keep).toBe(1);
            // The input is not mutated: this handler never edits what it read.
            expect(Object.prototype.hasOwnProperty.call(hostile, '__proto__')).toBe(true);
            expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
        });

        it('serialises version 2 / kind app / spec.source while preserving siblings', () => {
            const text = serializeDocument(
                { name: 'N', spec: { other: 1 } },
                {
                    relation: 'link',
                    branch: 'main',
                },
            );

            expect(text).toContain('version: 2');
            expect(text).toContain('kind: app');
            expect(text).toContain('other: 1');
            expect(text).toContain('name: N');
            expect(declaredKind(JSON.parse(JSON.stringify({ kind: 'app' })))).toBe('app');
        });

        it('recognises both spellings of a non-fast-forward refusal', () => {
            expect(isNonFastForward({ code: 'nonFastForward' })).toBe(true);
            expect(isNonFastForward(new GitProviderRequestError('conflict', 409))).toBe(true);
            expect(isNonFastForward(new GitProviderRequestError('unprocessable', 422))).toBe(false);
            expect(isNonFastForward(new Error('boom'))).toBe(false);
        });

        it('treats a YAML round trip of the same source as carried', () => {
            const composed = composedFor('fork');
            expect(branchCarries(composed, composed)).toBe(true);
            expect(branchCarries('', composed)).toBe(false);
            expect(branchCarries('version: 2\nkind: app\n', composed)).toBe(false);
        });
    });
});
