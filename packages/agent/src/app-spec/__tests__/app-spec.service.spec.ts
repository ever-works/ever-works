import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { APP_SPEC_EVALUATE_COALESCE_MS, APP_SPEC_LAZY_HEAD_CHECK_MS } from '@ever-works/contracts';
import type { AppSpec } from '@ever-works/contracts';
import { WorkAppSpecState } from '../../entities/work-app-spec-state.entity';
import { CacheEntry } from '../../entities/cache.entity';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { ActivityStatus } from '../../entities/activity-log.types';
import { GitFacadeService } from '../../facades/git.facade';
import { WorkRepository } from '../../database/repositories/work.repository';
import { AppSpecAppliedEvent } from '../../events/app-spec-applied.event';
import { APP_SPEC_EVALUATE_DISPATCHER } from '../../tasks/app-spec-evaluate-dispatcher';
import type { AppSpecEvaluatePayload } from '../../tasks/app-spec-evaluate.types';
import {
    APP_SPEC_ACTIVITY_ACTIONS,
    APP_SPEC_EVALUATE_MAX_PASSES,
    AppSpecService,
    appSpecEvaluateLockKey,
    type AppSpecEvaluationOutcome,
    type AppSpecWorkContext,
} from '../app-spec.service';
import { hashAppSpec } from '../app-spec-hash';

/**
 * APW-03 T12 — `AppSpecService`, against a **real** in-memory database.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local install), the CI
 * driver and the e2e stack, and the two properties that make an App Work's spec
 * state trustworthy are database properties: the coalescing statement's
 * conditional `UPDATE` and the `evaluatedSeq < :seq` guard. T11's repository spec
 * proves those in isolation; this one proves the **service** uses them — that a
 * request which coalesced is still satisfied, that an older evaluation writes and
 * publishes nothing, and that neither the Activity row nor the
 * `app.spec.applied` event is emitted for a state the platform does not have.
 *
 * Git is a fake repository model (branches → sha → file text) rather than a
 * mocked facade method, so a case can seed "a push landed while the job ran" the
 * same way a real repository would show it.
 *
 * Spec FR-15…FR-26, FR-89; ACC-03-09…ACC-03-15, ACC-03-57; plan §2.3 and §10.1.
 */

const WORK = '11111111-1111-4111-8111-111111111111';
const WORK_2 = '22222222-2222-4222-8222-222222222222';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A fixed "now" so the 5-second and 60-second windows are exact, never flaky. */
const BASE = Date.parse('2026-03-01T06:00:00.000Z');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_TRUNK = 'd'.repeat(40);

/**
 * A whole `.works/works.yml` whose `spec` block is valid in `data-repository` mode.
 *
 * `overrides` replaces a block; `removals` deletes one — a deleted key must be
 * ABSENT from the text, not present with a `null` value, or the fixture tests a
 * different document than the case says it does.
 */
function validDocument(overrides: Partial<AppSpec> = {}, removals: readonly string[] = []): string {
    const spec: Record<string, unknown> = {
        source: {
            relation: 'fork',
            upstream: { repo: 'calcom/cal.diy', defaultBranch: 'main' },
            branch: 'main',
        },
        build: { strategy: 'dockerfile', dockerfile: 'Dockerfile' },
        components: [{ name: 'web', role: 'web', port: 3000 }],
        dependencies: { postgres: { version: '16' } },
        env: [{ name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' }],
        ...(overrides as Record<string, unknown>),
    };
    for (const key of removals) {
        delete spec[key];
    }
    return `version: 2\nkind: app\nname: Demo app\nspec:\n${toYaml(spec, 4)}`;
}

/** A source-only document — APW-01's minimal file, valid with zero errors. */
function sourceOnlyDocument(extra = ''): string {
    return (
        'version: 2\nkind: app\nspec:\n' +
        '    source: { relation: fork, upstream: { repo: calcom/cal.diy, defaultBranch: main }, branch: main }\n' +
        extra
    );
}

/**
 * The smallest YAML writer the fixtures need — one level per indent step, arrays
 * of scalars inline, nested objects inline. Kept here (rather than importing the
 * `yaml` library) so a fixture's text is exactly what this file says it is.
 */
function toYaml(value: unknown, indent: number): string {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        return value.map((entry) => `${pad}- ${inline(entry)}`).join('\n');
    }
    return (
        Object.entries(value as Record<string, unknown>)
            // An `undefined` value is an ABSENT key, never the string "undefined".
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => `${pad}${key}: ${inline(entry)}`)
            .join('\n')
    );
}

function inline(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => inline(entry)).join(', ')}]`;
    }
    if (value && typeof value === 'object') {
        return `{ ${Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => `${key}: ${inline(entry)}`)
            .join(', ')} }`;
    }
    if (typeof value === 'string') {
        // A digit-only string MUST be quoted, or YAML gives the validator a number
        // (`dependencies.postgres.version: 16` is the enum `"16"`'s classic trap —
        // it cost this file one red run).
        return /^[A-Za-z0-9_./@*-]+$/.test(value) && !/^\d+$/.test(value) ? value : `'${value}'`;
    }
    return String(value);
}

interface BranchState {
    sha: string;
    text: string | null;
}

describe('AppSpecService (APW-03 T12)', () => {
    let dataSource: DataSource;
    let states: WorkAppSpecStateRepository;
    let locks: DistributedTaskLockService;
    let service: AppSpecService;

    /** The fake repository: branch → head sha and the file at that sha. */
    let branches: Map<string, BranchState>;
    let files: Map<string, string | null>;
    let getLatestCommit: jest.Mock;
    let getFileContent: jest.Mock;
    let findWork: jest.Mock;
    let activityLog: jest.Mock;
    let emitter: EventEmitter2;
    let emitted: AppSpecAppliedEvent[];
    let dispatchAppSpecEvaluate: jest.Mock;
    let nowMs: number;

    const now = () => nowMs;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        states = new WorkAppSpecStateRepository(dataSource.getRepository(WorkAppSpecState));
        locks = new DistributedTaskLockService(dataSource.getRepository(CacheEntry));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        // The owning Work row is not what is under test: `WorkRepository` is a
        // double, and the FK itself is asserted in
        // `apps/api/.../CreateWorkAppSpecStates.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkAppSpecState).clear();
        await dataSource.query('DELETE FROM "cache_entries"');
        await dataSource.query('DELETE FROM "works"');

        nowMs = BASE;

        branches = new Map<string, BranchState>();
        files = new Map<string, string | null>();
        setBranch('main', SHA_A, validDocument());

        getLatestCommit = jest.fn(
            async (_owner: string, _repo: string, branch: string, _options: unknown) => {
                const branchState = branches.get(branch);
                return branchState ? { sha: branchState.sha, message: 'x', author: 'x' } : null;
            },
        );

        getFileContent = jest.fn(
            async (
                _owner: string,
                _repo: string,
                _path: string,
                _options: unknown,
                ref?: string,
            ) => {
                const text = files.has(ref as string) ? files.get(ref as string) : null;
                return text === null || text === undefined
                    ? null
                    : { content: text, encoding: 'utf-8' };
            },
        );

        findWork = jest.fn(async (workId: string) => fakeWork(workId));

        activityLog = jest.fn(async (entry: Record<string, unknown>) => ({ id: 'row', ...entry }));

        emitted = [];
        emitter = new EventEmitter2();
        emitter.on(AppSpecAppliedEvent.EVENT_NAME, (event: AppSpecAppliedEvent) => {
            emitted.push(event);
        });

        dispatchAppSpecEvaluate = jest.fn(async (_payload: AppSpecEvaluatePayload) => 'run-1');

        service = new AppSpecService(
            states,
            { getLatestCommit, getFileContent } as unknown as GitFacadeService,
            locks,
            { findById: findWork } as unknown as WorkRepository,
            { log: activityLog } as unknown as ActivityLogService,
            emitter,
            { dispatchAppSpecEvaluate } as never,
        );
    });

    // ── helpers ─────────────────────────────────────────────────────────────

    function setBranch(branch: string, sha: string, text: string | null): void {
        branches.set(branch, { sha, text });
        files.set(sha, text);
    }

    /** A Work entity double — the four fields this service reads, plus its methods. */
    function fakeWork(workId: string): unknown {
        return {
            id: workId,
            userId: USER,
            tenantId: null,
            organizationId: ORG,
            gitProvider: 'github',
            sourceRepository: {
                type: 'app_fork',
                relatedRepositories: { website: { owner: 'ever-co', repo: 'demo-app' } },
            },
            getRepoOwner: () => 'ever-co',
            getWebsiteRepo: () => 'demo-app',
        };
    }

    /** A state row for the Work, as APW-01 would have created it. */
    function seedState(workId = WORK, trackedBranch = 'main') {
        return states.initialize(workId, trackedBranch, { tenantId: null, organizationId: ORG });
    }

    /** The stored row, re-read from the database rather than from a returned object. */
    async function stored(workId = WORK): Promise<WorkAppSpecState> {
        const row = await dataSource
            .getRepository(WorkAppSpecState)
            .findOneOrFail({ where: { workId } });
        return row;
    }

    /** The Activity rows this service wrote, in order. */
    function activityRows(): Record<string, unknown>[] {
        return activityLog.mock.calls.map((call) => call[0] as Record<string, unknown>);
    }

    function activityActions(): string[] {
        return activityRows().map((row) => row.action as string);
    }

    // ── initialize ──────────────────────────────────────────────────────────

    describe('initialize', () => {
        it('creates one row on the documented defaults and is idempotent', async () => {
            const first = await service.initialize(WORK, 'trunk', { organizationId: ORG });
            const second = await service.initialize(WORK, 'other', { organizationId: ORG });

            expect(second.id).toBe(first.id);
            const row = await stored();
            expect(row.trackedBranch).toBe('trunk');
            expect(row.validationStatus).toBe('missing');
            expect(row.organizationId).toBe(ORG);
            expect(Number(row.requestedSeq)).toBe(0);
        });
    });

    // ── requestEvaluation: the coalescing arithmetic, both directions ────────

    describe('requestEvaluation (FR-22, ACC-03-13)', () => {
        it('dispatches the first request and hands the runtime exactly the payload plan §6.1 fixes', async () => {
            await seedState();

            const outcome = await service.requestEvaluation(WORK, 'push', {
                tenantId: null,
                organizationId: ORG,
                providerId: 'github',
                credentialVersion: 3,
            });

            expect(outcome.dispatched).toBe(true);
            expect(outcome.coalesced).toBe(false);
            expect(outcome.ranInProcess).toBe(false);
            expect(outcome.runId).toBe('run-1');
            expect(outcome.requestedSeq).toBe(1);
            expect(outcome.evaluatedSeq).toBe(0);
            expect(dispatchAppSpecEvaluate).toHaveBeenCalledTimes(1);
            expect(dispatchAppSpecEvaluate).toHaveBeenCalledWith({
                workId: WORK,
                trigger: 'push',
                tenantId: null,
                organizationId: ORG,
                providerId: 'github',
                credentialVersion: 3,
            });
        });

        it('coalesces a second trigger inside the 5-second window — one dispatch, and the request is NOT lost', async () => {
            await seedState();

            const first = await service.requestEvaluation(WORK, 'push', {}, { now });
            nowMs = BASE + 1_000;
            const second = await service.requestEvaluation(WORK, 'manual', {}, { now });
            nowMs = BASE + 4_999;
            const third = await service.requestEvaluation(WORK, 'pr_merged', {}, { now });

            expect(first.dispatched).toBe(true);
            expect(second.dispatched).toBe(false);
            expect(second.coalesced).toBe(true);
            expect(third.dispatched).toBe(false);
            // One job is on its way for three triggers…
            expect(dispatchAppSpecEvaluate).toHaveBeenCalledTimes(1);
            // …and every request is counted: the waiting job reads the newest
            // sequence when it starts, so the coalesced triggers are satisfied by it.
            const row = await stored();
            expect(Number(row.requestedSeq)).toBe(3);
            expect(Number(row.evaluatedSeq)).toBe(0);
        });

        it('dispatches again once the window has passed', async () => {
            await seedState();

            await service.requestEvaluation(WORK, 'push', {}, { now });
            // The window is `dispatchedAt >= now - 5000`, so exactly 5 000 ms still
            // coalesces (the landed repository's own boundary, T11) and the next
            // millisecond does not.
            nowMs = BASE + APP_SPEC_EVALUATE_COALESCE_MS + 1;
            const late = await service.requestEvaluation(WORK, 'manual', {}, { now });

            expect(late.dispatched).toBe(true);
            expect(dispatchAppSpecEvaluate).toHaveBeenCalledTimes(2);
        });

        it('dispatches again once the waiting job has started and finished (the window is not the only rule)', async () => {
            await seedState();

            await service.requestEvaluation(WORK, 'push');
            // The first job starts and completes.
            await service.evaluate(WORK);
            nowMs = BASE + 1_000;
            const next = await service.requestEvaluation(WORK, 'manual', {}, { now });

            expect(next.dispatched).toBe(true);
            expect(dispatchAppSpecEvaluate).toHaveBeenCalledTimes(2);
        });

        it('runs the handler in-process when the runtime answers null (plan §6.1:661-662)', async () => {
            await seedState();
            dispatchAppSpecEvaluate.mockResolvedValue(null);

            const outcome = await service.requestEvaluation(WORK, 'created');

            expect(outcome.dispatched).toBe(true);
            expect(outcome.runId).toBeNull();
            expect(outcome.ranInProcess).toBe(true);
            // The evaluation really ran: the row carries the head reading.
            expect(outcome.evaluation?.status).toBe('evaluated');
            const row = await stored();
            expect(row.headCommitSha).toBe(SHA_A);
            expect(row.validationStatus).toBe('valid');
        });

        it('runs the handler in-process when no dispatcher token is bound at all', async () => {
            await seedState();
            const bare = new AppSpecService(
                states,
                { getLatestCommit, getFileContent } as unknown as GitFacadeService,
                locks,
                { findById: findWork } as unknown as WorkRepository,
                { log: activityLog } as unknown as ActivityLogService,
                emitter,
            );

            const outcome = await bare.requestEvaluation(WORK, 'created');

            expect(outcome.ranInProcess).toBe(true);
            expect(outcome.reason).toBe('dispatcherUnavailable');
            expect((await stored()).headCommitSha).toBe(SHA_A);
        });

        it('reports work_not_found for a Work whose state row is gone, and dispatches nothing', async () => {
            const outcome = await service.requestEvaluation(WORK_2, 'push');

            expect(outcome.requested).toBe(false);
            expect(outcome.dispatched).toBe(false);
            expect(outcome.reason).toBe('work_not_found');
            expect(dispatchAppSpecEvaluate).not.toHaveBeenCalled();
        });
    });

    // ── evaluate: the head reading ──────────────────────────────────────────

    describe('evaluate — the head reading (FR-15, FR-19, FR-24)', () => {
        it('reads the TRACKED branch only: a push on another branch changes nothing (ACC-03-09)', async () => {
            await seedState();
            // Another branch carries a different, newer spec.
            setBranch(
                'feature',
                SHA_C,
                validDocument({ display: { protectedPaths: ['other/**'] } }),
            );

            const outcome = await service.evaluate(WORK);

            expect(outcome.status).toBe('evaluated');
            expect(outcome.written).toBe(true);
            // The facade was asked for `main` and never for `feature`.
            for (const call of getLatestCommit.mock.calls) {
                expect(call[2]).toBe('main');
            }
            const row = await stored();
            expect(row.headCommitSha).toBe(SHA_A);
            expect(row.validationStatus).toBe('valid');
        });

        it('updates the state and records app.spec.validated when a push changes the spec', async () => {
            await seedState();

            const outcome = await service.evaluate(WORK);

            expect(outcome.validationStatus).toBe('valid');
            expect(outcome.headCommitSha).toBe(SHA_A);
            expect(outcome.effectiveCommitSha).toBe(SHA_A);
            expect(outcome.applied).toBe(true);
            expect(activityActions()).toEqual([
                APP_SPEC_ACTIVITY_ACTIONS.validated,
                APP_SPEC_ACTIVITY_ACTIONS.applied,
            ]);
            const row = await stored();
            expect(row.validationStatus).toBe('valid');
            expect(row.headSpecHash).toHaveLength(64);
            expect(row.effectiveSpecHash).toBe(row.headSpecHash);
            expect(row.lastEvaluationTrigger).toBe('manual');
        });

        it('keeps the effective spec when the head becomes invalid, and answers invalid for that commit (ACC-03-10)', async () => {
            await seedState();
            await service.evaluate(WORK);
            const before = await stored();

            // A push that breaks R2: `build.strategy` without `components`.
            setBranch(
                'main',
                SHA_B,
                validDocument({ build: { strategy: 'image' } }, ['components']),
            );

            const outcome = await service.evaluate(WORK);

            expect(outcome.validationStatus).toBe('invalid');
            expect(outcome.errorCount).toBeGreaterThan(0);
            const after = await stored();
            expect(after.headCommitSha).toBe(SHA_B);
            expect(after.effectiveCommitSha).toBe(before.effectiveCommitSha);
            expect(after.effectiveSpecHash).toBe(before.effectiveSpecHash);
            expect(after.effectiveSpec).toEqual(before.effectiveSpec);

            const read = await service.getEffectiveSpec(WORK, SHA_B);
            expect(read?.status).toBe('invalid');
            expect(read?.issues?.length).toBeGreaterThan(0);
            expect(read?.spec).toBeNull();
        });

        it('records app.spec.invalid once, as FAILED, with the problem count', async () => {
            await seedState();
            setBranch(
                'main',
                SHA_B,
                validDocument({ build: { strategy: 'image' } }, ['components']),
            );

            await service.evaluate(WORK);
            await service.evaluate(WORK);

            expect(activityActions()).toEqual([APP_SPEC_ACTIVITY_ACTIONS.invalid]);
            expect(activityRows()[0].status).toBe(ActivityStatus.FAILED);
            expect(activityRows()[0].summary).toBe('App spec has 1 problems');
            expect(emitted).toEqual([]);
        });

        it('keeps the effective spec when the file is deleted on the tracked branch', async () => {
            await seedState();
            await service.evaluate(WORK);
            const before = await stored();

            setBranch('main', SHA_B, null);

            const outcome = await service.evaluate(WORK);

            expect(outcome.validationStatus).toBe('missing');
            const after = await stored();
            expect(after.validationStatus).toBe('missing');
            expect(after.effectiveCommitSha).toBe(before.effectiveCommitSha);
            expect(after.effectiveSpec).toEqual(before.effectiveSpec);
        });

        it('keeps the effective spec and records the code when the provider throws (unreadable)', async () => {
            await seedState();
            await service.evaluate(WORK);
            const before = await stored();

            getFileContent.mockRejectedValueOnce(new Error('rate limited'));

            const outcome = await service.evaluate(WORK);

            expect(outcome.validationStatus).toBe('unreadable');
            const after = await stored();
            expect(after.lastEvaluationError).toContain('file_unreadable');
            expect(after.effectiveSpec).toEqual(before.effectiveSpec);
            expect(activityActions()).not.toContain(APP_SPEC_ACTIVITY_ACTIONS.invalid);
        });

        it('reports unreadable when the head cannot be read at all', async () => {
            await seedState();
            await service.evaluate(WORK);
            const before = await stored();

            getLatestCommit.mockRejectedValueOnce(new Error('502'));

            const outcome = await service.evaluate(WORK);

            expect(outcome.validationStatus).toBe('unreadable');
            const after = await stored();
            expect(after.lastEvaluationError).toContain('head_unreadable');
            expect(after.effectiveSpecHash).toBe(before.effectiveSpecHash);
        });

        it('advances the head commit without any Activity when a push does not touch the spec (FR-24)', async () => {
            await seedState();
            await service.evaluate(WORK);
            const recorded = activityActions().length;

            // The same content at a new commit: the head moves, the spec hash does not.
            setBranch('main', SHA_B, validDocument());

            const outcome = await service.evaluate(WORK);

            expect(outcome.headCommitSha).toBe(SHA_B);
            expect(outcome.validationStatus).toBe('valid');
            // The effective commit advances (the spec IS effective at the new commit)
            // but the applied event does not fire — FR-21 is a hash rule.
            expect(outcome.applied).toBe(false);
            expect(emitted).toHaveLength(1);
            expect(activityActions()).toHaveLength(recorded);
        });

        it('records no Activity for an identical re-evaluation (ACC-03-11)', async () => {
            await seedState();
            await service.evaluate(WORK);
            const recorded = activityRows().length;

            await service.evaluate(WORK);
            await service.evaluate(WORK);

            expect(activityRows()).toHaveLength(recorded);
            expect(emitted).toHaveLength(1);
        });

        it('classifies a warnings-only head as valid_with_warnings and still makes it effective', async () => {
            await seedState();
            setBranch(
                'main',
                SHA_A,
                validDocument({ build: { strategy: 'image', image: 'nginx:latest' } }, [
                    // No dependencies and no env: the two blocks that would need one.
                    'dependencies',
                    'env',
                ]),
            );

            const outcome = await service.evaluate(WORK);

            expect(outcome.validationStatus).toBe('valid_with_warnings');
            expect(outcome.warningCount).toBeGreaterThan(0);
            expect(outcome.effectiveCommitSha).toBe(SHA_A);
            expect(outcome.applied).toBe(true);
        });

        it('exits clean when the state row is gone — nothing is resurrected (plan §9.2)', async () => {
            const outcome = await service.evaluate(WORK_2);

            expect(outcome.status).toBe('no_state');
            expect(outcome.written).toBe(false);
            expect(activityLog).not.toHaveBeenCalled();
            expect(emitted).toEqual([]);
        });
    });

    // ── the ordering guard ──────────────────────────────────────────────────

    describe('ordering — an older evaluation never overwrites a newer result (FR-22, ACC-03-12)', () => {
        it('writes nothing, records nothing and emits nothing when its sequence has been superseded', async () => {
            await seedState();
            // The request this (older) job will claim.
            await service.requestEvaluation(WORK, 'push');

            // A NEWER evaluation finished first: it wrote with seq 5.
            const newerSpec = { display: { name: 'newer' } };
            const wrote = await states.writeEvaluation(WORK, 5, {
                trigger: 'manual',
                headCommitSha: SHA_B,
                headSpecHash: hashAppSpec(newerSpec),
                validationStatus: 'valid',
                errorCount: 0,
                warningCount: 0,
                issues: [],
                effectiveCommitSha: SHA_B,
                effectiveSpecHash: hashAppSpec(newerSpec),
                effectiveSpec: newerSpec as AppSpec,
            });
            expect(wrote).toBe(true);

            const outcome = await service.evaluate(WORK);

            expect(outcome.written).toBe(false);
            expect(outcome.superseded).toBe(true);
            // The newer result is untouched…
            const row = await stored();
            expect(row.evaluatedSeq).toBe(5);
            expect(row.headCommitSha).toBe(SHA_B);
            expect(row.effectiveSpec).toEqual(newerSpec);
            // …and the loser published nothing: no Activity, no event.
            expect(activityLog).not.toHaveBeenCalled();
            expect(emitted).toEqual([]);
        });
    });

    // ── the applied event ───────────────────────────────────────────────────

    describe('app.spec.applied — once per effective-hash transition (FR-21)', () => {
        it('emits exactly one event for one transition, with the contract’s payload fields', async () => {
            await seedState();

            await service.evaluate(WORK);

            expect(emitted).toHaveLength(1);
            const event = emitted[0];
            expect(event).toBeInstanceOf(AppSpecAppliedEvent);
            expect(event.workId).toBe(WORK);
            expect(event.commitSha).toBe(SHA_A);
            expect(event.previousCommitSha).toBeNull();
            expect(event.specHash).toHaveLength(64);
            expect(event.changedBlocks).toEqual(
                expect.arrayContaining(['source', 'build', 'components']),
            );
            expect(event.addedDependencies).toEqual(['postgres']);
            expect(event.changedEnvNames).toEqual(['DATABASE_URL']);
        });

        it('does not emit twice for a transition that changes both the head and the effective spec', async () => {
            await seedState();
            await service.evaluate(WORK);

            setBranch(
                'main',
                SHA_B,
                validDocument({ build: { strategy: 'image', image: 'nginx:1.27' } }),
            );
            const outcome = await service.evaluate(WORK);

            expect(outcome.applied).toBe(true);
            expect(emitted).toHaveLength(2);
            expect(emitted[1].previousCommitSha).toBe(SHA_A);
            expect(emitted[1].changedBlocks).toEqual(['build']);
        });

        it('reports the dependency, env and block deltas between the two effective specs', async () => {
            await seedState();
            await service.evaluate(WORK);

            setBranch(
                'main',
                SHA_B,
                validDocument({
                    dependencies: { postgres: { version: '16' }, redis: { version: '7' } },
                    env: [
                        { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
                        { name: 'REDIS_URL', secret: true, from: 'deps.redis.url' },
                        { name: 'FEATURE_FLAG', value: '1' },
                    ],
                    checks: [{ name: 'type-check', command: 'pnpm type-check' }],
                }),
            );

            await service.evaluate(WORK);

            expect(emitted).toHaveLength(2);
            expect(emitted[1].addedDependencies).toEqual(['redis']);
            expect(emitted[1].changedEnvNames).toEqual(['REDIS_URL', 'FEATURE_FLAG']);
            expect(emitted[1].changedBlocks).toEqual(
                expect.arrayContaining(['dependencies', 'env', 'checks']),
            );
            expect(emitted[1].changedBlocks).not.toContain('source');
        });

        it('never carries a secret VALUE — names and hashes only (R8)', async () => {
            await seedState();
            await service.evaluate(WORK);

            const serialised = JSON.stringify(emitted[0]);
            expect(serialised).not.toContain('deps.postgres.url"');
            expect(serialised).toContain('DATABASE_URL');
        });

        it('emits nothing when no EventEmitter2 is bound, and says so', async () => {
            await seedState();
            const bare = new AppSpecService(
                states,
                { getLatestCommit, getFileContent } as unknown as GitFacadeService,
                locks,
                { findById: findWork } as unknown as WorkRepository,
                { log: activityLog } as unknown as ActivityLogService,
            );

            const outcome = await bare.evaluate(WORK);

            expect(outcome.applied).toBe(true);
            expect(outcome.eventEmitted).toBe(false);
            expect(emitted).toEqual([]);
            // The write still happened: the missing bus never fails an evaluation.
            expect((await stored()).effectiveSpecHash).toHaveLength(64);
        });
    });

    // ── the lock and the pass loop ──────────────────────────────────────────

    describe('the per-Work lock (plan §2.3:178)', () => {
        it('answers locked, writing nothing, when another evaluation holds the lock', async () => {
            await seedState();

            const held = await locks.runExclusive(appSpecEvaluateLockKey(WORK), async () => {
                return service.evaluate(WORK);
            });

            expect(held.acquired).toBe(true);
            expect(held.result?.status).toBe('locked');
            expect(held.result?.written).toBe(false);
            expect(getLatestCommit).not.toHaveBeenCalled();
            const row = await stored();
            expect(row.headCommitSha).toBeNull();
        });

        it('settles a trigger that arrived DURING the run: the pass loop leaves the row not pending', async () => {
            await seedState();

            // A trigger lands while the first pass is reading the file.
            let injected = false;
            getFileContent.mockImplementation(async () => {
                if (!injected) {
                    injected = true;
                    await states.requestEvaluation(WORK);
                }
                return { content: validDocument(), encoding: 'utf-8' };
            });

            const outcome = await service.evaluate(WORK);

            expect(outcome.passes).toBe(2);
            const row = await stored();
            expect(Number(row.evaluatedSeq)).toBe(Number(row.requestedSeq));
            expect(outcome.written).toBe(true);
        });

        it('never runs more passes than the bound', async () => {
            await seedState();
            // Every pass is followed by another request: the loop must still stop.
            getFileContent.mockImplementation(async () => {
                await states.requestEvaluation(WORK);
                return { content: validDocument(), encoding: 'utf-8' };
            });

            const outcome = await service.evaluate(WORK);

            expect(outcome.passes).toBe(APP_SPEC_EVALUATE_MAX_PASSES);
        });
    });

    // ── the tracked branch move (FR-16) ─────────────────────────────────────

    describe('the tracked branch move (FR-16)', () => {
        it('adopts a branch a valid head declares, when that branch declares the same branch', async () => {
            await seedState();
            setBranch(
                'trunk',
                SHA_TRUNK,
                validDocument({
                    source: {
                        relation: 'fork',
                        upstream: { repo: 'calcom/cal.diy' },
                        branch: 'trunk',
                    },
                }),
            );
            setBranch(
                'main',
                SHA_A,
                validDocument({
                    source: {
                        relation: 'fork',
                        upstream: { repo: 'calcom/cal.diy' },
                        branch: 'trunk',
                    },
                }),
            );

            const outcome = await service.evaluate(WORK);

            expect(outcome.trackedBranchMoved).toBe(true);
            expect(outcome.passes).toBe(2);
            const row = await stored();
            expect(row.trackedBranch).toBe('trunk');
            expect(row.headCommitSha).toBe(SHA_TRUNK);
        });

        it('refuses the move and records tracked_branch_missing when the declared branch does not exist', async () => {
            await seedState();
            setBranch(
                'main',
                SHA_A,
                validDocument({
                    source: {
                        relation: 'fork',
                        upstream: { repo: 'calcom/cal.diy' },
                        branch: 'nope',
                    },
                }),
            );

            const outcome = await service.evaluate(WORK);

            expect(outcome.trackedBranchMoved).toBe(false);
            const row = await stored();
            expect(row.trackedBranch).toBe('main');
            expect(row.lastEvaluationError).toBe('tracked_branch_missing');
        });

        it('refuses the move when the declared branch’s own spec declares a different branch', async () => {
            await seedState();
            setBranch(
                'trunk',
                SHA_TRUNK,
                validDocument({
                    source: {
                        relation: 'fork',
                        upstream: { repo: 'calcom/cal.diy' },
                        branch: 'main',
                    },
                }),
            );
            setBranch(
                'main',
                SHA_A,
                validDocument({
                    source: {
                        relation: 'fork',
                        upstream: { repo: 'calcom/cal.diy' },
                        branch: 'trunk',
                    },
                }),
            );

            await service.evaluate(WORK);

            const row = await stored();
            expect(row.trackedBranch).toBe('main');
            expect(row.lastEvaluationError).toBe('tracked_branch_missing');
        });
    });

    // ── getState and the lazy head check (ACC-03-14) ────────────────────────

    describe('getState — the 60-second lazy head check (FR-19(d), ACC-03-14)', () => {
        it('checks the head once on the first read and schedules an evaluation when it moved', async () => {
            await seedState();

            const first = await service.getState(WORK, { now });

            expect(first.status).toBe('ok');
            expect(first.lazyCheck.checked).toBe(true);
            expect(first.lazyCheck.headChanged).toBe(true);
            expect(first.lazyCheck.requested).toBe(true);
            expect(getLatestCommit).toHaveBeenCalledTimes(1);
        });

        it('does not check again inside the 60-second window, however many reads arrive', async () => {
            await seedState();
            await service.getState(WORK, { now });

            const reads = [];
            for (let index = 0; index < 5; index += 1) {
                nowMs = BASE + 1_000 * (index + 1);
                reads.push(await service.getState(WORK, { now }));
            }

            expect(reads.every((read) => read.lazyCheck.checked === false)).toBe(true);
            expect(reads.every((read) => read.lazyCheck.reason === 'checkedRecently')).toBe(true);
            expect(getLatestCommit).toHaveBeenCalledTimes(1);
        });

        it('checks again once the window has passed, and only schedules when the head really moved', async () => {
            await seedState();
            // The lazy check's request runs in-process (no runtime), so the row
            // carries the head it just read — which is what the NEXT comparison is
            // against.
            dispatchAppSpecEvaluate.mockResolvedValue(null);
            await service.getState(WORK, { now });
            expect((await stored()).headCommitSha).toBe(SHA_A);

            nowMs = BASE + APP_SPEC_LAZY_HEAD_CHECK_MS;
            const second = await service.getState(WORK, { now });
            expect(second.lazyCheck.checked).toBe(true);
            expect(second.lazyCheck.headChanged).toBe(false);
            expect(second.lazyCheck.requested).toBe(false);

            // A real push: the head moves and the next check schedules an evaluation.
            setBranch('main', SHA_B, validDocument());
            nowMs = BASE + APP_SPEC_LAZY_HEAD_CHECK_MS * 2;
            const third = await service.getState(WORK, { now });
            expect(third.lazyCheck.checked).toBe(true);
            expect(third.lazyCheck.headChanged).toBe(true);
            expect(third.lazyCheck.requested).toBe(true);
        });

        it('publishes evaluationPending from the sequences, not from a flag', async () => {
            await seedState();
            await service.requestEvaluation(WORK, 'push');
            dispatchAppSpecEvaluate.mockResolvedValue('run-1');

            const pending = await service.getState(WORK, { now: () => BASE + 1 });
            expect(pending.evaluationPending).toBe(true);
        });

        it('reports no_state for a Work with no row, and checks nothing', async () => {
            const read = await service.getState(WORK_2, { now });

            expect(read.status).toBe('no_state');
            expect(read.state).toBeNull();
            expect(read.lazyCheck.checked).toBe(false);
            expect(getLatestCommit).not.toHaveBeenCalled();
        });

        it('never throws when the head cannot be read; it names the reason', async () => {
            await seedState();
            getLatestCommit.mockRejectedValueOnce(new Error('offline'));

            const read = await service.getState(WORK, { now });

            expect(read.status).toBe('ok');
            expect(read.lazyCheck.checked).toBe(true);
            expect(read.lazyCheck.reason).toBe('headUnreadable');
            expect(read.lazyCheck.requested).toBe(false);
        });
    });

    // ── getEffectiveSpec ────────────────────────────────────────────────────

    describe('getEffectiveSpec (FR-19(g), plan §2.3:195-198)', () => {
        it('answers from the stored effective spec without a provider read', async () => {
            await seedState();
            await service.evaluate(WORK);
            getLatestCommit.mockClear();
            getFileContent.mockClear();

            const read = await service.getEffectiveSpec(WORK);

            expect(read?.status).toBe('valid');
            expect(read?.source).toBe('stored');
            expect(read?.commitSha).toBe(SHA_A);
            expect(read?.specHash).toHaveLength(64);
            expect(read?.spec).toBeTruthy();
            expect(getLatestCommit).not.toHaveBeenCalled();
            expect(getFileContent).not.toHaveBeenCalled();
        });

        it('answers from the store for the effective commit asked for, and reads any other commit', async () => {
            await seedState();
            await service.evaluate(WORK);
            getFileContent.mockClear();

            const storedRead = await service.getEffectiveSpec(WORK, SHA_A);
            expect(storedRead?.source).toBe('stored');
            expect(getFileContent).not.toHaveBeenCalled();

            const otherRead = await service.getEffectiveSpec(WORK, SHA_B);
            expect(otherRead?.source).toBe('read');
            expect(otherRead?.status).toBe('missing');
        });

        it('rebuilds the value in memory when the cache column is empty, and writes nothing', async () => {
            await seedState();
            await service.evaluate(WORK);
            // A row written before the cache existed: the commit is known, the spec is not.
            await dataSource
                .getRepository(WorkAppSpecState)
                .update({ workId: WORK }, { effectiveSpec: null });
            getFileContent.mockClear();

            const read = await service.getEffectiveSpec(WORK);

            expect(read?.status).toBe('valid');
            expect(read?.source).toBe('stored');
            expect(read?.commitSha).toBe(SHA_A);
            expect(getFileContent).toHaveBeenCalledWith(
                'ever-co',
                'demo-app',
                '.works/works.yml',
                expect.anything(),
                SHA_A,
            );
            // Nothing was written back.
            expect((await stored()).effectiveSpec).toBeNull();
        });

        it('answers null for a Work with no App spec state at all', async () => {
            expect(await service.getEffectiveSpec(WORK_2)).toBeNull();
        });

        it('reports unreadable — not invalid — when the repository cannot be resolved', async () => {
            await seedState();
            findWork.mockResolvedValue(null);

            const read = await service.getEffectiveSpec(WORK, SHA_A);

            expect(read?.status).toBe('unreadable');
            expect(read?.spec).toBeNull();
        });
    });

    // ── validateDraft ───────────────────────────────────────────────────────

    describe('validateDraft (plan §2.7:382, §4.1:548)', () => {
        it('validates text without storing anything', async () => {
            await seedState();

            const result = await service.validateDraft(WORK, validDocument());

            expect(result.status).toBe('valid');
            expect(result.errorCount).toBe(0);
            const row = await stored();
            expect(row.headCommitSha).toBeNull();
            expect(row.validationStatus).toBe('missing');
            expect(activityLog).not.toHaveBeenCalled();
            expect(emitted).toEqual([]);
        });

        it('returns the issues for text that does not validate, and stores nothing', async () => {
            await seedState();

            const result = await service.validateDraft(
                WORK,
                validDocument({ build: { strategy: 'image' } }, ['components']),
            );

            expect(result.status).toBe('invalid');
            expect(result.issues.length).toBeGreaterThan(0);
            expect((await stored()).validationStatus).toBe('missing');
        });

        it('never throws on text that is not YAML at all', async () => {
            await seedState();

            const result = await service.validateDraft(WORK, 'spec: [unclosed');

            expect(result.status).toBe('invalid');
            expect(result.errorCount).toBeGreaterThan(0);
        });
    });

    // ── parseDraft (APW-08 T17's head-spec read) ────────────────────

    describe('parseDraft — the same verdict, keeping the document', () => {
        it('answers the parsed spec beside the verdict', async () => {
            // APW-08's change guard compares two `AppSpec`s
            // (`diffGuardedSpecBlocks`), and a comparison needs two documents
            // rather than two verdicts.
            await seedState();

            const result = await service.parseDraft(WORK, validDocument());

            expect(result.status).toBe('valid');
            expect(result.spec).not.toBeNull();
            // `AppSpec` is the `spec:` BLOCK, not the whole document — it has
            // `source` / `display` / `agents` at its top level and no `kind`.
            // That is why `isProtectedPath(spec, path)` reads
            // `spec.display.protectedPaths` directly.
            expect(result.spec).toHaveProperty('source');
            expect(result.spec).not.toHaveProperty('kind');
        });

        it('answers a NULL spec for a document with errors, by APW-03\u2019s own rule', async () => {
            // Not an oversight and not a parse failure: this document parses.
            // `app-spec.validate.ts:200-209` says `spec` is non-null *only when
            // the document has zero errors* — FR-20 — and that *"the best-effort
            // copy the rules ran on is deliberately not exposed: treating it as
            // 'the spec' is exactly the mistake strictness exists to prevent"*.
            //
            // It lines up exactly with what APW-08's guard needs: a head spec
            // that does not validate arrives as `null`, which the guard already
            // treats as "read and invalid" and refuses on.
            await seedState();

            const result = await service.parseDraft(
                WORK,
                validDocument({ build: { strategy: 'image' } }, ['components']),
            );

            expect(result.status).toBe('invalid');
            expect(result.errorCount).toBeGreaterThan(0);
            expect(result.spec).toBeNull();
        });

        it('answers a null spec for text that is not YAML at all', async () => {
            await seedState();

            const result = await service.parseDraft(WORK, 'spec: [unclosed');

            expect(result.status).toBe('invalid');
            expect(result.spec).toBeNull();
        });

        it('gives validateDraft the IDENTICAL verdict — one validation path', async () => {
            await seedState();
            const text = validDocument();

            const parsed = await service.parseDraft(WORK, text);
            const validated = await service.validateDraft(WORK, text);
            const { spec: _dropped, ...verdict } = parsed;

            expect(validated).toEqual(verdict);
        });

        it('validateDraft does NOT carry the spec — it is an HTTP response', async () => {
            // `AppSpecDraftValidationDto implements AppSpecDraftValidation` and is
            // returned by `POST /api/works/:id/app-spec/validate`. Widening that
            // interface would push a member's whole App spec into a response that
            // exists to say whether their draft parses.
            await seedState();

            const validated = await service.validateDraft(WORK, validDocument());

            expect(validated).not.toHaveProperty('spec');
        });
    });

    // ── hasValidAppSpec (ACC-03-57, FR-89) ──────────────────────────────────

    describe('hasValidAppSpec (FR-89, ACC-03-57)', () => {
        it('answers false for an absent file', async () => {
            await seedState();
            files.set(SHA_B, null);

            expect(await service.hasValidAppSpec(WORK, SHA_B)).toBe(false);
        });

        it('answers false for a source-only file', async () => {
            await seedState();
            setBranch('main', SHA_B, sourceOnlyDocument());

            expect(await service.hasValidAppSpec(WORK, SHA_B)).toBe(false);
        });

        it('answers false for a source-only file carrying an x- extension key', async () => {
            await seedState();
            setBranch('main', SHA_B, sourceOnlyDocument("    x-note: 'still source only'\n"));

            expect(await service.hasValidAppSpec(WORK, SHA_B)).toBe(false);
        });

        it('answers true for a valid spec with a build and components', async () => {
            await seedState();

            expect(await service.hasValidAppSpec(WORK, SHA_A)).toBe(true);
        });

        it('answers false for the same spec with an R1/R2 error', async () => {
            await seedState();
            setBranch(
                'main',
                SHA_B,
                validDocument({ build: { strategy: 'image' } }, ['components']),
            );

            expect(await service.hasValidAppSpec(WORK, SHA_B)).toBe(false);
        });

        it('answers false for a document that does not select kind app', async () => {
            await seedState();
            setBranch('main', SHA_B, validDocument().replace('kind: app', 'kind: website'));

            expect(await service.hasValidAppSpec(WORK, SHA_B)).toBe(false);
        });

        it('answers from the commit while the evaluation state still reads missing (ACC-03-57)', async () => {
            await seedState();
            const row = await stored();
            expect(row.validationStatus).toBe('missing');

            expect(await service.hasValidAppSpec(WORK, SHA_A)).toBe(true);
            // It never consulted the state row: the predicate is about the commit.
            expect((await stored()).validationStatus).toBe('missing');
        });

        it('writes nothing and records nothing', async () => {
            await seedState();

            await service.hasValidAppSpec(WORK, SHA_A);

            expect(activityLog).not.toHaveBeenCalled();
            expect(emitted).toEqual([]);
            const row = await stored();
            expect(row.headCommitSha).toBeNull();
            expect(Number(row.evaluatedSeq)).toBe(0);
        });

        it('answers false rather than throwing when the provider fails', async () => {
            await seedState();
            getFileContent.mockRejectedValueOnce(new Error('boom'));

            expect(await service.hasValidAppSpec(WORK, SHA_A)).toBe(false);
        });

        it('answers false for an empty workId or commitSha', async () => {
            await seedState();

            expect(await service.hasValidAppSpec(WORK, '')).toBe(false);
            expect(await service.hasValidAppSpec('', SHA_A)).toBe(false);
        });
    });

    // ── the work context ────────────────────────────────────────────────────

    describe('the Work context (README §1’s repository-role note)', () => {
        it('reads the Work Repository (website role) and the Work owner’s token, never the data role', async () => {
            await seedState();

            await service.evaluate(WORK);

            const options = (getLatestCommit.mock.calls[0] as unknown[])[3] as Record<
                string,
                unknown
            >;
            expect((getLatestCommit.mock.calls[0] as unknown[])[0]).toBe('ever-co');
            expect((getLatestCommit.mock.calls[0] as unknown[])[1]).toBe('demo-app');
            expect(options.userId).toBe(USER);
            expect(options.providerId).toBe('github');
            expect(options.workId).toBe(WORK);
        });

        it('reports repositoryUnresolved rather than reading a repository it cannot name', async () => {
            await seedState();
            findWork.mockResolvedValue({
                id: WORK,
                userId: USER,
                gitProvider: 'github',
                getRepoOwner: () => '',
                getWebsiteRepo: () => '',
            } as unknown as AppSpecWorkContext);

            const outcome = await service.evaluate(WORK);

            expect(outcome.status).toBe('work_missing');
            expect(getLatestCommit).not.toHaveBeenCalled();
        });

        it('stamps the Activity row with the Work owner and its scope (R-34)', async () => {
            await seedState();

            await service.evaluate(WORK);

            const row = activityRows()[0];
            expect(row.userId).toBe(USER);
            expect(row.workId).toBe(WORK);
            expect(row.actionType).toBe('app_spec');
            expect(row.organizationId).toBe(ORG);
        });

        it('writes no row and counts the loss when the Work has no resolvable owner (R-34)', async () => {
            await seedState();
            findWork.mockResolvedValue({
                id: WORK,
                userId: '',
                gitProvider: 'github',
                sourceRepository: {
                    type: 'app_fork',
                    relatedRepositories: { website: { owner: 'ever-co', repo: 'demo-app' } },
                },
                getRepoOwner: () => 'ever-co',
                getWebsiteRepo: () => 'demo-app',
            } as unknown as AppSpecWorkContext);

            const outcome = await service.evaluate(WORK);

            expect(outcome.written).toBe(true);
            expect(outcome.activityRecorded).toBe(false);
            expect(activityLog).not.toHaveBeenCalled();
        });
    });
});
