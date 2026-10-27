import { DataSource } from 'typeorm';
import { APP_UPSTREAM_SYNC_MANUAL_PER_HOUR } from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { TaskRepository } from '../../database/repositories/task.repository';
import { OrganizationRepository } from '../../database/repositories/organization.repository';
import { TenantRepository } from '../../database/repositories/tenant.repository';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Task } from '../../entities/task.entity';
import { Tenant } from '../../entities/tenant.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkMemberRole } from '../../entities/types';
import { Work } from '../../entities/work.entity';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import {
    APP_UPSTREAM_WORKER_ACTIVITY_ACTIONS,
    AppUpstreamRefusalError,
    AppUpstreamStateService,
    appUpstreamWorkerActivitySink,
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

    // ── Owner decision 2026-10-27 — "Sync anyway" by an Owner of the Organization ──

    describe('Sync anyway — the Work owner or an Owner of the Work’s Organization (2026-10-27)', () => {
        const TENANT_ID = '33333333-3333-4333-8333-333333333301';
        const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333302';
        const ORG_ID = '44444444-4444-4444-8444-444444444401';
        const ORG_OWNER = '11111111-1111-4111-8111-111111111104';
        const ORG_ADMIN = '11111111-1111-4111-8111-111111111105';
        const ORG_MEMBER = '11111111-1111-4111-8111-111111111106';
        const STRANGER = '11111111-1111-4111-8111-111111111107';

        function orgService(): AppUpstreamStateService {
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
                new OrganizationRepository(dataSource.getRepository(Organization)),
                new TenantRepository(dataSource.getRepository(Tenant)),
            );
        }

        async function addWorkMember(userId: string, role: WorkMemberRole): Promise<void> {
            const repo = dataSource.getRepository(WorkMember);
            await repo.save(repo.create({ workId: WORK_ID, userId, role } as Partial<WorkMember>));
        }

        beforeEach(async () => {
            await dataSource.getRepository(OrganizationMember).clear();
            await dataSource.getRepository(Organization).clear();
            await dataSource.getRepository(Tenant).clear();

            await dataSource.getRepository(Tenant).save(
                dataSource.getRepository(Tenant).create({
                    id: TENANT_ID,
                    ownerUserId: ORG_OWNER,
                    slug: 'acme-tenant',
                    displayName: 'Acme',
                } as Partial<Tenant>),
            );
            await dataSource.getRepository(Organization).save(
                dataSource.getRepository(Organization).create({
                    id: ORG_ID,
                    tenantId: TENANT_ID,
                    slug: 'acme',
                    displayName: 'Acme',
                } as Partial<Organization>),
            );
            // The roster: an Admin and a Member (the Owner holds no roster row by construction).
            const roster = dataSource.getRepository(OrganizationMember);
            for (const [userId, role] of [
                [ORG_ADMIN, 'admin'],
                [ORG_MEMBER, 'member'],
            ] as const) {
                await roster.save(
                    roster.create({
                        organizationId: ORG_ID,
                        tenantId: TENANT_ID,
                        userId,
                        role,
                        joinedAt: new Date(),
                    } as Partial<OrganizationMember>),
                );
            }
            // The Work belongs to the Organization; the three Organization people can edit it.
            await dataSource
                .getRepository(Work)
                .update({ id: WORK_ID }, { organizationId: ORG_ID, tenantId: TENANT_ID } as never);
            await addWorkMember(ORG_OWNER, WorkMemberRole.EDITOR);
            await addWorkMember(ORG_ADMIN, WorkMemberRole.EDITOR);
            await addWorkMember(ORG_MEMBER, WorkMemberRole.EDITOR);
        });

        it('lets an Owner of the Organization release, and the audit row names them and how', async () => {
            await seedState(heldState());

            await expect(
                orgService().requestSync(WORK_ID, ORG_OWNER, {
                    confirmWorkflowChanges: true,
                    workflowHeadSha: HELD,
                }),
            ).resolves.toEqual({ queued: true, runId: 'run-sync-1' });

            expect((await stored()).workflowRelease).toMatchObject({
                headSha: HELD,
                releasedByUserId: ORG_OWNER,
            });
            const [audit] = events('app.upstream.workflow_released');
            expect(audit.summary).toBe(
                'An Owner of the Organization accepted upstream workflow changes',
            );
            expect(audit.details).toMatchObject({
                releasedByUserId: ORG_OWNER,
                releasedAs: 'organization_owner',
                upstreamHeadSha: HELD,
            });
        });

        it('still lets the Work owner release, recorded as the Work owner', async () => {
            await seedState(heldState());

            await orgService().requestSync(WORK_ID, OWNER, { confirmWorkflowChanges: true });

            expect((await stored()).workflowRelease).toMatchObject({ releasedByUserId: OWNER });
            const [audit] = events('app.upstream.workflow_released');
            expect(audit.summary).toBe('The owner accepted upstream workflow changes');
            expect(audit.details).toMatchObject({
                releasedByUserId: OWNER,
                releasedAs: 'work_owner',
            });
        });

        it.each([
            ['an Organization Admin', ORG_ADMIN],
            ['an Organization Member', ORG_MEMBER],
            ['a Work editor outside the Organization', EDITOR],
        ])(
            'refuses %s with edit access — 403 owner_required, nothing recorded',
            async (_label, who) => {
                await seedState(heldState());

                const refusal = await refusalOf(
                    orgService().requestSync(WORK_ID, who, { confirmWorkflowChanges: true }),
                );

                expect(refusal.code).toBe('owner_required');
                expect(refusal.status).toBe(403);
                expect((await stored()).workflowRelease ?? null).toBeNull();
                expect(events('app.upstream.workflow_released')).toHaveLength(0);
                expect(syncDispatcher.dispatch).not.toHaveBeenCalled();
            },
        );

        it('answers the release gate: creator and Organization Owner only; a stranger is 404', async () => {
            await seedState(heldState());
            const gate = orgService();

            await expect(gate.mayReleaseWorkflowChanges(WORK_ID, OWNER)).resolves.toBe(true);
            await expect(gate.mayReleaseWorkflowChanges(WORK_ID, ORG_OWNER)).resolves.toBe(true);
            await expect(gate.mayReleaseWorkflowChanges(WORK_ID, ORG_ADMIN)).resolves.toBe(false);
            await expect(gate.mayReleaseWorkflowChanges(WORK_ID, ORG_MEMBER)).resolves.toBe(false);
            await expect(gate.mayReleaseWorkflowChanges(WORK_ID, EDITOR)).resolves.toBe(false);
            expect((await refusalOf(gate.mayReleaseWorkflowChanges(WORK_ID, STRANGER))).code).toBe(
                'not_found',
            );
            // The creator-only check is unchanged.
            await expect(gate.isWorkOwner(WORK_ID, ORG_OWNER)).resolves.toBe(false);
        });

        it('offers Sync anyway on the card to the Organization Owner, not to an Admin or Member', async () => {
            await seedState(heldState());
            const view = orgService();

            expect((await view.get(WORK_ID, ORG_OWNER)).sync?.workflowHold?.canRelease).toBe(true);
            expect((await view.get(WORK_ID, OWNER)).sync?.workflowHold?.canRelease).toBe(true);
            expect((await view.get(WORK_ID, ORG_ADMIN)).sync?.workflowHold?.canRelease).toBe(false);
            expect((await view.get(WORK_ID, ORG_MEMBER)).sync?.workflowHold?.canRelease).toBe(
                false,
            );
        });

        it('keeps the edit-access rule for the Organization Owner: a viewer is offered nothing and refused', async () => {
            await dataSource
                .getRepository(WorkMember)
                .update({ workId: WORK_ID, userId: ORG_OWNER }, { role: WorkMemberRole.VIEWER });
            await seedState(heldState());

            expect(
                (await orgService().get(WORK_ID, ORG_OWNER)).sync?.workflowHold?.canRelease,
            ).toBe(false);
            const refusal = await refusalOf(
                orgService().requestSync(WORK_ID, ORG_OWNER, { confirmWorkflowChanges: true }),
            );
            expect(refusal.code).toBe('edit_access_required');
            expect((await stored()).workflowRelease ?? null).toBeNull();
        });

        it('fails closed when the Work’s Tenant stamp disagrees with its Organization’s', async () => {
            await dataSource
                .getRepository(Work)
                .update({ id: WORK_ID }, { tenantId: OTHER_TENANT_ID } as never);
            await seedState(heldState());

            const refusal = await refusalOf(
                orgService().requestSync(WORK_ID, ORG_OWNER, { confirmWorkflowChanges: true }),
            );
            expect(refusal.code).toBe('owner_required');
        });

        it('gives a personal Work (no Organization) only its creator, and an unbound graph too', async () => {
            await dataSource
                .getRepository(Work)
                .update({ id: WORK_ID }, { organizationId: null, tenantId: null } as never);
            await seedState(heldState());

            expect(
                (
                    await refusalOf(
                        orgService().requestSync(WORK_ID, ORG_OWNER, {
                            confirmWorkflowChanges: true,
                        }),
                    )
                ).code,
            ).toBe('owner_required');

            // Organization-scoped again, but without the two repositories bound: creator only.
            await dataSource
                .getRepository(Work)
                .update({ id: WORK_ID }, { organizationId: ORG_ID, tenantId: TENANT_ID } as never);
            expect(
                (
                    await refusalOf(
                        service().requestSync(WORK_ID, ORG_OWNER, { confirmWorkflowChanges: true }),
                    )
                ).code,
            ).toBe('owner_required');
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

            expect(await states.claimSyncPullRequestChecks(Date.now(), 600_000, 50)).toHaveLength(
                0,
            );
        });
    });

    // ── the worker's Activity rows (lane aw-safety's open item, 2026-10-27) ──

    describe('recordWorkerActivity — the upstream sync worker Activity sink', () => {
        it('writes an allowed action as the Work owner, with the type derived from the action', async () => {
            await seedState();

            const sink = appUpstreamWorkerActivitySink(service());
            await sink.log({
                userId: 'someone-else',
                workId: WORK_ID,
                actionType: 'not-a-type',
                action: 'app.upstream.held',
                status: 'pending',
                summary: 'Upstream changed its workflows.',
                details: { paths: [WORKFLOW], pathCount: 1 },
            } as never);

            const [entry] = events('app.upstream.held');
            expect(entry).toMatchObject({
                userId: OWNER,
                workId: WORK_ID,
                actionType: 'app_upstream',
                status: 'pending',
                details: { paths: [WORKFLOW], pathCount: 1 },
            });
        });

        it('maps fork and Actions actions to their own types and coerces an unknown status', async () => {
            await seedState();

            await service().recordWorkerActivity(WORK_ID, {
                action: 'app.fork.missing',
                status: 'exploded',
            });
            await service().recordWorkerActivity(WORK_ID, { action: 'app.actions.disabled' });

            expect(events('app.fork.missing')[0]).toMatchObject({
                actionType: 'app_fork',
                status: 'completed',
            });
            expect(events('app.actions.disabled')[0]).toMatchObject({ actionType: 'app_actions' });
        });

        it('refuses any action outside the closed set, and a malformed Work id', async () => {
            await seedState();

            expect(await service().recordWorkerActivity(WORK_ID, { action: 'auth.login' })).toBe(
                false,
            );
            expect(
                await service().recordWorkerActivity('not-a-uuid', { action: 'app.upstream.held' }),
            ).toBe(false);
            expect(activity.log).not.toHaveBeenCalled();
        });

        it('drops an oversized details bag rather than storing it', async () => {
            await seedState();

            await service().recordWorkerActivity(WORK_ID, {
                action: 'app.upstream.behind',
                details: { blob: 'x'.repeat(20_000) },
            });

            const [entry] = events('app.upstream.behind');
            expect(entry).toBeDefined();
            expect(entry.details).toBeUndefined();
        });

        it('allows exactly the six worker actions', () => {
            expect([...APP_UPSTREAM_WORKER_ACTIVITY_ACTIONS].sort()).toEqual(
                [
                    'app.actions.disabled',
                    'app.fork.missing',
                    'app.upstream.behind',
                    'app.upstream.held',
                    'app.upstream.unavailable',
                    'app.upstream.workflow_release_used',
                ].sort(),
            );
        });
    });
});
