import { DataSource } from 'typeorm';
import { APP_UPSTREAM_SYNC_MANUAL_PER_HOUR } from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { TaskRepository } from '../../database/repositories/task.repository';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { Task } from '../../entities/task.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkMemberRole } from '../../entities/types';
import { Work } from '../../entities/work.entity';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import {
    AppUpstreamRefusalError,
    AppUpstreamStateService,
    isAppUpstreamRefusalError,
} from '../app-upstream-state.service';

/**
 * APW-02 T46 + T47 (2026-10-27) — the state-service halves of the two loops:
 *
 * - **T46** `requestSync(…, { confirmWorkflowChanges })` — the owner's "Sync anyway" is
 *   recorded on the row (never on the job payload), bound to the held head, audited, and
 *   refused for anyone who is not the Work owner; a plain **Sync now** on a still-current
 *   hold answers `409 workflow_confirmation_required` with the paths.
 * - **T47** `checkSyncPullRequest` — merged ⇒ the `merged` finish run is queued; closed ⇒
 *   the pull request is cleared and `pull_request_closed` recorded; open ⇒ only the stamp.
 *
 * Real SQLite through the real repositories, as `app-upstream-state.service.spec.ts` does.
 */
const OWNER = '11111111-1111-4111-8111-111111111101';
const EDITOR = '11111111-1111-4111-8111-111111111103';
const WORK_ID = '22222222-2222-4222-8222-222222222201';
const HELD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const NEWER = 'ccccccccccccccccccccccccccccccccccccccc3';
const WORKFLOW = '.github/workflows/release.yml';

describe('AppUpstreamStateService — T46 release and T47 sync pull request check', () => {
    let dataSource: DataSource;
    let states: WorkUpstreamStateRepository;
    let works: WorkRepository;
    let members: WorkMemberRepository;
    let taskRepository: TaskRepository;
    let git: { getPullRequestStatus: jest.Mock };
    let activity: { log: jest.Mock };
    let syncDispatcher: { dispatch: jest.Mock };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        states = new WorkUpstreamStateRepository(dataSource.getRepository(WorkUpstreamState));
        works = new WorkRepository(dataSource.getRepository(Work));
        members = new WorkMemberRepository(dataSource.getRepository(WorkMember));
        taskRepository = new TaskRepository(dataSource.getRepository(Task));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkMember).clear();
        await dataSource.getRepository(WorkUpstreamState).clear();
        await dataSource.getRepository(Work).clear();
        git = {
            getPullRequestStatus: jest
                .fn()
                .mockResolvedValue({ number: 7, state: 'open', merged: false, headSha: HELD }),
        };
        activity = { log: jest.fn().mockResolvedValue({ id: 'activity-1' }) };
        syncDispatcher = { dispatch: jest.fn().mockResolvedValue('run-sync-1') };

        const workRepo = dataSource.getRepository(Work);
        await workRepo.save(
            workRepo.create({
                id: WORK_ID,
                name: 'Cal',
                slug: 'cal-0201',
                description: 'An app Work',
                userId: OWNER,
                kind: 'app',
            } as Partial<Work>),
        );
        const memberRepo = dataSource.getRepository(WorkMember);
        await memberRepo.save(
            memberRepo.create({
                workId: WORK_ID,
                userId: EDITOR,
                role: WorkMemberRole.EDITOR,
            } as Partial<WorkMember>),
        );
    });

    function service(): AppUpstreamStateService {
        return new AppUpstreamStateService(
            states,
            works,
            members,
            git as never,
            taskRepository,
            undefined,
            undefined,
            activity as never,
            undefined,
            undefined,
            undefined,
            undefined,
            syncDispatcher as never,
        );
    }

    async function seedState(overrides: Partial<WorkUpstreamState> = {}): Promise<void> {
        const repo = dataSource.getRepository(WorkUpstreamState);
        await repo.save(
            repo.create({
                workId: WORK_ID,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'cal',
                dataDefaultBranch: 'main',
                upstreamOwner: 'upstream-co',
                upstreamRepo: 'cal',
                upstreamDefaultBranch: 'main',
                readinessState: 'ready',
                readinessStartedAt: new Date(),
                readyAt: new Date(),
                ...overrides,
            }),
        );
    }

    function heldState(overrides: Partial<WorkUpstreamState> = {}): Partial<WorkUpstreamState> {
        return {
            lastSyncResult: 'skipped',
            lastSyncReason: 'held_for_workflow_review',
            lastSyncedUpstreamSha: HELD,
            upstreamHeadSha: HELD,
            workflowHold: {
                headSha: HELD,
                paths: [WORKFLOW],
                pathCount: 1,
                complete: true,
                heldAt: '2026-10-27T01:00:00.000Z',
            },
            ...overrides,
        };
    }

    async function stored(): Promise<WorkUpstreamState> {
        return dataSource
            .getRepository(WorkUpstreamState)
            .findOneOrFail({ where: { workId: WORK_ID } });
    }

    async function refusalOf(promise: Promise<unknown>): Promise<AppUpstreamRefusalError> {
        try {
            await promise;
        } catch (error) {
            expect(isAppUpstreamRefusalError(error)).toBe(true);
            return error as AppUpstreamRefusalError;
        }
        throw new Error('expected the call to be refused');
    }

    function events(action: string): Array<Record<string, any>> {
        return activity.log.mock.calls
            .map((call) => call[0] as Record<string, any>)
            .filter((entry) => entry.action === action);
    }

    // ── T46 ──────────────────────────────────────────────────────────────────

    describe('T46 — Sync now on a held range', () => {
        it('refuses a plain Sync now while the hold is for the current head, naming the paths', async () => {
            await seedState(heldState());

            const refusal = await refusalOf(service().requestSync(WORK_ID, OWNER));

            expect(refusal.code).toBe('workflow_confirmation_required');
            expect(refusal.status).toBe(409);
            expect(refusal.details).toMatchObject({
                headSha: HELD,
                pathCount: '1',
                paths: WORKFLOW,
            });
            expect(syncDispatcher.dispatch).not.toHaveBeenCalled();
            // The refusal spent none of the six hourly syncs.
            expect((await stored()).manualSyncCount ?? 0).toBe(0);
        });

        it('lets a plain Sync now re-check once upstream moved past the held head', async () => {
            await seedState(heldState({ upstreamHeadSha: NEWER }));

            await expect(service().requestSync(WORK_ID, OWNER)).resolves.toEqual({
                queued: true,
                runId: 'run-sync-1',
            });
            expect((await stored()).workflowRelease ?? null).toBeNull();
        });

        it('records the owner release on the row, audits it, and queues a manual run', async () => {
            await seedState(heldState());

            await expect(
                service().requestSync(WORK_ID, OWNER, {
                    confirmWorkflowChanges: true,
                    workflowHeadSha: HELD,
                }),
            ).resolves.toEqual({ queued: true, runId: 'run-sync-1' });

            const row = await stored();
            expect(row.workflowRelease).toMatchObject({
                headSha: HELD,
                paths: [WORKFLOW],
                pathCount: 1,
                complete: true,
                releasedByUserId: OWNER,
            });
            // The job payload carries no confirmation: the row is the only carrier.
            expect(syncDispatcher.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                trigger: 'manual',
            });
            const [audit] = events('app.upstream.workflow_released');
            expect(audit).toBeDefined();
            expect(audit.details).toMatchObject({
                upstreamHeadSha: HELD,
                paths: [WORKFLOW],
                releasedByUserId: OWNER,
            });
            // Paths and counts only — no file content in the audit row.
            expect(JSON.stringify(audit.details)).not.toMatch(/patch|content/i);
        });

        it('refuses a member with edit access: only the Work owner may accept workflow changes', async () => {
            await seedState(heldState());

            const refusal = await refusalOf(
                service().requestSync(WORK_ID, EDITOR, { confirmWorkflowChanges: true }),
            );

            expect(refusal.code).toBe('owner_required');
            expect(refusal.status).toBe(403);
            expect((await stored()).workflowRelease ?? null).toBeNull();
            expect(syncDispatcher.dispatch).not.toHaveBeenCalled();
        });

        it('refuses a release when nothing is held', async () => {
            await seedState();

            const refusal = await refusalOf(
                service().requestSync(WORK_ID, OWNER, { confirmWorkflowChanges: true }),
            );

            expect(refusal.code).toBe('no_workflow_hold');
            expect(refusal.status).toBe(409);
        });

        it('refuses a release for a head the owner did not review', async () => {
            await seedState(heldState());

            const refusal = await refusalOf(
                service().requestSync(WORK_ID, OWNER, {
                    confirmWorkflowChanges: true,
                    workflowHeadSha: NEWER,
                }),
            );

            expect(refusal.code).toBe('workflow_hold_changed');
            expect(refusal.details).toMatchObject({ headSha: HELD });
            expect((await stored()).workflowRelease ?? null).toBeNull();
        });

        it('records no release when the hourly allowance refuses the run', async () => {
            await seedState(
                heldState({
                    manualSyncCount: APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
                    manualSyncWindowAt: new Date(),
                }),
            );

            const refusal = await refusalOf(
                service().requestSync(WORK_ID, OWNER, { confirmWorkflowChanges: true }),
            );

            expect(refusal.code).toBe('sync_limit_reached');
            expect((await stored()).workflowRelease ?? null).toBeNull();
            expect(events('app.upstream.workflow_released')).toHaveLength(0);
        });

        it('reports the hold on the card, with the release offered to the owner only', async () => {
            await seedState(heldState());

            const forOwner = await service().get(WORK_ID, OWNER);
            const forEditor = await service().get(WORK_ID, EDITOR);

            expect(forOwner.sync?.workflowHold).toMatchObject({
                headSha: HELD,
                paths: [WORKFLOW],
                pathCount: 1,
                complete: true,
                canRelease: true,
                compareUrl: `https://github.com/ever-works/cal/compare/main...${HELD}`,
            });
            expect(forEditor.sync?.workflowHold?.canRelease).toBe(false);
        });
    });

    // ── T47 ──────────────────────────────────────────────────────────────────

    describe('T47 — checkSyncPullRequest', () => {
        it('queues the merged finish run when the sync pull request was merged', async () => {
            await seedState({ syncPullRequestNumber: 7, syncPullRequestUrl: 'https://x/pull/7' });
            git.getPullRequestStatus.mockResolvedValue({
                number: 7,
                state: 'merged',
                merged: true,
                headSha: HELD,
            });

            const check = await service().checkSyncPullRequest(WORK_ID);

            expect(check).toMatchObject({ status: 'merged', runId: 'run-sync-1' });
            expect(syncDispatcher.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                trigger: 'merged',
            });
            expect((await stored()).syncPullRequestCheckedAt).toBeInstanceOf(Date);
        });

        it('clears a pull request closed without merging and records its head (S26)', async () => {
            await seedState({ syncPullRequestNumber: 7, syncPullRequestUrl: 'https://x/pull/7' });
            git.getPullRequestStatus.mockResolvedValue({
                number: 7,
                state: 'closed',
                merged: false,
                headSha: HELD,
            });

            const check = await service().checkSyncPullRequest(WORK_ID);

            expect(check.status).toBe('closed');
            const row = await stored();
            expect(row.syncPullRequestNumber ?? null).toBeNull();
            expect(row.syncPullRequestUrl ?? null).toBeNull();
            expect(row.syncPullRequestClosedHeadSha).toBe(HELD);
            expect(row.lastSyncReason).toBe('pull_request_closed');
            expect(syncDispatcher.dispatch).not.toHaveBeenCalled();
        });

        it('only stamps an open pull request, and skips while a sync runs', async () => {
            await seedState({ syncPullRequestNumber: 7 });

            expect((await service().checkSyncPullRequest(WORK_ID)).status).toBe('open');
            expect(syncDispatcher.dispatch).not.toHaveBeenCalled();

            await dataSource
                .getRepository(WorkUpstreamState)
                .update({ workId: WORK_ID }, { syncStartedAt: new Date(), syncFinishedAt: null });
            git.getPullRequestStatus.mockClear();
            expect((await service().checkSyncPullRequest(WORK_ID)).status).toBe('busy');
            expect(git.getPullRequestStatus).not.toHaveBeenCalled();
        });

        it('has nothing to check without a sync pull request on record', async () => {
            await seedState();

            expect((await service().checkSyncPullRequest(WORK_ID)).status).toBe('not_open');
            expect(git.getPullRequestStatus).not.toHaveBeenCalled();
        });
    });

    describe('T47 — claimSyncPullRequestChecks', () => {
        it('claims due rows once, stamps them, and honours the interval', async () => {
            await seedState({ syncPullRequestNumber: 7 });
            const now = Date.now();

            const first = await states.claimSyncPullRequestChecks(now, 600_000, 50);
            const again = await states.claimSyncPullRequestChecks(now + 1_000, 600_000, 50);
            const later = await states.claimSyncPullRequestChecks(now + 601_000, 600_000, 50);

            expect(first.map((row) => row.workId)).toEqual([WORK_ID]);
            expect(again).toHaveLength(0);
            expect(later.map((row) => row.workId)).toEqual([WORK_ID]);
        });

        it('never claims a row without a sync pull request', async () => {
            await seedState();

            expect(await states.claimSyncPullRequestChecks(Date.now(), 600_000, 50)).toHaveLength(0);
        });
    });
});
