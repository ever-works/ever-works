import { NotFoundException } from '@nestjs/common';
import type { FindOptionsWhere, Repository } from 'typeorm';
import { AgentsService } from './agents/agents.service';
import {
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from './entities/agent.entity';
import { Goal, GoalStatus } from './entities/goal.entity';
import type { GoalMetricSample } from './entities/goal-metric-sample.entity';
import type { MissionGoal } from './entities/mission-goal.entity';
import { Mission, MissionStatus, MissionType } from './entities/mission.entity';
import type { Work } from './entities/work.entity';
import { GoalsService } from './goals/goals.service';
import type { GoalEvaluationService } from './goals/goal-evaluation.service';
import { MissionsService } from './missions/missions.service';
import { TitlerService } from './titler/titler.service';

const EVER_SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const OTHER_SCOPE = {
    tenantId: EVER_SCOPE.tenantId,
    organizationId: '33333333-3333-4333-8333-333333333333',
};
const FOREIGN_SCOPE = {
    tenantId: '44444444-4444-4444-8444-444444444444',
    organizationId: '55555555-5555-4555-8555-555555555555',
};
const PERSONAL_SCOPE = { tenantId: EVER_SCOPE.tenantId, organizationId: null };

type OwnershipScope = typeof EVER_SCOPE | typeof PERSONAL_SCOPE;

function isNullOperator(value: unknown): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { _type?: string })._type === 'isNull'
    );
}

function matchesWhere<T extends Record<string, unknown>>(
    row: T,
    where: FindOptionsWhere<T> | FindOptionsWhere<T>[] | undefined,
): boolean {
    if (!where) return true;
    if (Array.isArray(where)) return where.some((branch) => matchesWhere(row, branch));
    return Object.entries(where).every(([key, expected]) => {
        if (isNullOperator(expected)) return row[key] == null;
        return row[key] === expected;
    });
}

function scopedRows<
    T extends { userId: string; tenantId?: string | null; organizationId?: string | null },
>(rows: T[], userId: string, scope?: OwnershipScope): T[] {
    return rows.filter((row) => {
        if (row.userId !== userId) return false;
        if (!scope) return true;
        if (scope.organizationId === null) {
            return (
                row.organizationId == null &&
                (row.tenantId == null || row.tenantId === scope.tenantId)
            );
        }
        return row.tenantId === scope.tenantId && row.organizationId === scope.organizationId;
    });
}

function mission(overrides: Partial<Mission>): Mission {
    return {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: 'user-1',
        title: 'Mission',
        description: 'Mission description',
        type: MissionType.ONE_SHOT,
        status: MissionStatus.ACTIVE,
        outcome: null,
        completedAt: null,
        schedule: null,
        autoBuildWorks: false,
        outstandingIdeasCap: null,
        guardrailsOverride: null,
        missionTemplateRepo: null,
        missionRepo: null,
        sourceMissionId: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-08-22T00:00:00.000Z'),
        updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        ...overrides,
    };
}

function goal(overrides: Partial<Goal>): Goal {
    return {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        userId: 'user-1',
        title: 'Goal',
        description: null,
        metricSource: { pluginId: 'stripe', metricId: 'income' },
        comparator: 'gte',
        targetValue: 100,
        unit: 'usd',
        window: 'month',
        baselineValue: null,
        currentValue: null,
        currentValueAt: null,
        deadline: null,
        checkFrequencyMinutes: 60,
        nextCheckAt: null,
        status: GoalStatus.DRAFT,
        outcome: null,
        criteria: null,
        constraints: null,
        resolvedScore: null,
        dodCriteria: null,
        spendCapCents: null,
        spentCents: 0,
        wallClockLimitHours: null,
        stuckThresholdIterations: null,
        sessionBudgetMinutes: null,
        gracePeriodMinutes: null,
        executionTarget: null,
        plannerModelHint: null,
        workerModelHint: null,
        iteration: 0,
        lastProgressIteration: 0,
        activeAgentId: null,
        assignedAgentId: null,
        loopStatus: null,
        loopStartedAt: null,
        archivedAt: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-08-22T00:00:00.000Z'),
        updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        ...overrides,
    } as Goal;
}

function agent(overrides: Partial<Agent>): Agent {
    return {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        userId: 'user-1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'Agent',
        slug: 'agent',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        environmentId: null,
        maxSkillContextTokens: 4000,
        memoryRecallEnabled: true,
        status: AgentStatus.DRAFT,
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        guardrails: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        committerName: null,
        committerEmail: null,
        reportsToAgentId: null,
        scorecard: null,
        initScript: null,
        soulMd: null,
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-08-22T00:00:00.000Z'),
        updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        ...overrides,
    } as Agent;
}

describe('Organization ownership scoping', () => {
    const uploadSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    describe('Agent and Mission attachment upload scope', () => {
        it('404s when an Ever Agent is given the same user upload hash from Yo', async () => {
            const ownedAgent = agent({ id: 'agent-ever', ...EVER_SCOPE });
            const foreignUpload = {
                sha256: uploadSha,
                userId: 'user-1',
                storagePath: uploadSha,
                ...OTHER_SCOPE,
            };
            const edges = {
                add: jest.fn(async () => ({
                    id: 'edge-1',
                    agentId: ownedAgent.id,
                    uploadId: uploadSha,
                })),
                findByAgentId: jest.fn(async () => []),
            };
            const uploads = {
                findOne: jest.fn(
                    async (options: { where?: FindOptionsWhere<typeof foreignUpload> }) =>
                        matchesWhere(foreignUpload, options.where) ? foreignUpload : null,
                ),
            };
            const service = new AgentsService(
                { findByIdAndUser: jest.fn(async () => ownedAgent) } as never,
                {} as never,
                {} as never,
                edges as never,
                undefined,
                undefined,
                undefined,
                uploads as never,
            );

            await expect(
                service.addAttachment('user-1', ownedAgent.id, uploadSha, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(edges.add).not.toHaveBeenCalled();
        });

        it('does not expose metadata or a URL for a Yo upload through an Ever Agent edge', async () => {
            const ownedAgent = agent({ id: 'agent-ever', ...EVER_SCOPE });
            const foreignUpload = {
                sha256: uploadSha,
                userId: 'user-1',
                storagePath: `${uploadSha}.txt`,
                originalFilename: 'yo-secret.txt',
                mimeType: 'text/plain',
                fileSize: 9,
                ...OTHER_SCOPE,
            };
            const edges = {
                findByAgentId: jest.fn(async () => [
                    { id: 'edge-1', agentId: ownedAgent.id, uploadId: uploadSha },
                ]),
            };
            const uploads = {
                find: jest.fn(
                    async (options: { where?: FindOptionsWhere<typeof foreignUpload> }) =>
                        matchesWhere(foreignUpload, options.where) ? [foreignUpload] : [],
                ),
            };
            const service = new AgentsService(
                { findByIdAndUser: jest.fn(async () => ownedAgent) } as never,
                {} as never,
                {} as never,
                edges as never,
                undefined,
                undefined,
                undefined,
                uploads as never,
            );

            // The Agent endpoint was ownership-validated; the edge row itself
            // carries only the hash the caller attached. The Yo upload's
            // metadata must not leak, but the list must not fail either
            // (legacy pre-stamping uploads would otherwise 404 the owner's
            // whole list) - the row comes back UN-ENRICHED.
            const rows = await service.listAttachments('user-1', ownedAgent.id, EVER_SCOPE);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ id: 'edge-1', uploadId: uploadSha });
            expect(rows[0]).not.toHaveProperty('url');
            expect(rows[0]).not.toHaveProperty('filename');
        });

        it('404s an Ever Mission attachment whose upload hash belongs to Yo', async () => {
            const ownedMission = mission({ id: 'mission-ever', ...EVER_SCOPE });
            const attachments = { add: jest.fn() };
            const foreignUpload = {
                sha256: uploadSha,
                userId: 'user-1',
                ...OTHER_SCOPE,
            };
            const uploads = {
                findOne: jest.fn(
                    async (options: { where?: FindOptionsWhere<typeof foreignUpload> }) =>
                        matchesWhere(foreignUpload, options.where) ? foreignUpload : null,
                ),
            };
            const service = new MissionsService(
                { findOne: jest.fn(async () => ownedMission) } as never,
                new TitlerService(),
                undefined,
                attachments as never,
                uploads as never,
            );

            await expect(
                service.addAttachment('user-1', ownedMission.id, uploadSha, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(attachments.add).not.toHaveBeenCalled();
        });

        it('does not expose a Mission attachment edge backed by the same-user Yo hash', async () => {
            const ownedMission = mission({ id: 'mission-ever', ...EVER_SCOPE });
            const attachments = {
                findByMissionId: jest.fn(async () => [
                    { id: 'edge-yo', missionId: ownedMission.id, uploadId: uploadSha },
                ]),
            };
            const foreignUpload = {
                sha256: uploadSha,
                userId: 'user-1',
                ...OTHER_SCOPE,
            };
            const uploads = {
                find: jest.fn(
                    async (options: { where?: FindOptionsWhere<typeof foreignUpload> }) =>
                        matchesWhere(foreignUpload, options.where) ? [foreignUpload] : [],
                ),
            };
            const service = new MissionsService(
                { findOne: jest.fn(async () => ownedMission) } as never,
                new TitlerService(),
                undefined,
                attachments as never,
                uploads as never,
            );

            // Same contract as the Agent twin: the validated Mission is the
            // authority; a same-user upload row that is invisible in the
            // CURRENT scope neither leaks metadata (none is joined here) nor
            // fails the owner's whole attachment list.
            await expect(
                service.listAttachments('user-1', ownedMission.id, EVER_SCOPE),
            ).resolves.toEqual([expect.objectContaining({ id: 'edge-yo', uploadId: uploadSha })]);
        });

        it('persists a canonical lowercase Mission attachment hash for an uppercase input', async () => {
            const ownedMission = mission({ id: 'mission-ever', ...EVER_SCOPE });
            const edge = { id: 'edge-up', missionId: ownedMission.id, uploadId: uploadSha };
            const attachments = { add: jest.fn(async () => edge) };
            const ownedUpload = { sha256: uploadSha, userId: 'user-1', ...EVER_SCOPE };
            const uploads = {
                findOne: jest.fn(
                    async (options: { where?: FindOptionsWhere<typeof ownedUpload> }) =>
                        matchesWhere(ownedUpload, options.where) ? ownedUpload : null,
                ),
            };
            const service = new MissionsService(
                { findOne: jest.fn(async () => ownedMission) } as never,
                new TitlerService(),
                undefined,
                attachments as never,
                uploads as never,
            );

            await service.addAttachment(
                'user-1',
                ownedMission.id,
                uploadSha.toUpperCase(),
                EVER_SCOPE,
            );

            // user_uploads.sha256 is stored lowercase; persisting the raw
            // uppercase input would create an edge the upload join (and the
            // duplicate-recovery re-read) could never resolve again.
            expect(attachments.add).toHaveBeenCalledWith(ownedMission.id, uploadSha);
        });

        it('keeps legacy personal Agent attachment metadata and URL readable', async () => {
            const legacyAgent = agent({
                id: 'agent-personal',
                tenantId: null,
                organizationId: null,
            });
            const edges = {
                findByAgentId: jest.fn(async () => [
                    { id: 'edge-personal', agentId: legacyAgent.id, uploadId: uploadSha },
                ]),
            };
            const uploads = {
                find: jest.fn(async () => [
                    {
                        sha256: uploadSha,
                        userId: 'user-1',
                        storagePath: `${uploadSha}.txt`,
                        originalFilename: 'legacy.txt',
                        mimeType: 'text/plain',
                        fileSize: 9,
                        tenantId: null,
                        organizationId: null,
                    },
                ]),
            };
            const service = new AgentsService(
                { findByIdAndUser: jest.fn(async () => legacyAgent) } as never,
                {} as never,
                {} as never,
                edges as never,
                undefined,
                undefined,
                undefined,
                uploads as never,
            );

            await expect(
                service.listAttachments('user-1', legacyAgent.id, PERSONAL_SCOPE),
            ).resolves.toEqual([
                expect.objectContaining({
                    filename: 'legacy.txt',
                    url: `/api/uploads/user-1/${uploadSha}.txt`,
                }),
            ]);
        });

        it('keeps a legacy personal Mission and upload compatible with personal scope', async () => {
            const legacyMission = mission({
                id: 'mission-personal',
                tenantId: null,
                organizationId: null,
            });
            const edge = { id: 'edge-personal', missionId: legacyMission.id, uploadId: uploadSha };
            const attachments = { add: jest.fn(async () => edge) };
            const uploads = {
                findOne: jest.fn(async () => ({
                    sha256: uploadSha,
                    userId: 'user-1',
                    tenantId: null,
                    organizationId: null,
                })),
            };
            const service = new MissionsService(
                { findOne: jest.fn(async () => legacyMission) } as never,
                new TitlerService(),
                undefined,
                attachments as never,
                uploads as never,
            );

            await expect(
                service.addAttachment('user-1', legacyMission.id, uploadSha, PERSONAL_SCOPE),
            ).resolves.toEqual(edge);
        });
    });

    describe('MissionsService', () => {
        function makeService(rows: Mission[]) {
            const repo = {
                find: jest.fn(
                    async (options: {
                        where?: FindOptionsWhere<Mission> | FindOptionsWhere<Mission>[];
                    }) =>
                        rows.filter((row) =>
                            matchesWhere(
                                row as unknown as Record<string, unknown>,
                                options.where as never,
                            ),
                        ),
                ),
                findOne: jest.fn(
                    async (options: {
                        where?: FindOptionsWhere<Mission> | FindOptionsWhere<Mission>[];
                    }) =>
                        rows.find((row) =>
                            matchesWhere(
                                row as unknown as Record<string, unknown>,
                                options.where as never,
                            ),
                        ) ?? null,
                ),
                create: jest.fn((partial: Partial<Mission>) => mission(partial)),
                save: jest.fn(async (row: Mission) => {
                    row.tenantId = EVER_SCOPE.tenantId;
                    row.organizationId = EVER_SCOPE.organizationId;
                    const index = rows.findIndex((candidate) => candidate.id === row.id);
                    if (index === -1) rows.push(row);
                    else rows[index] = row;
                    return row;
                }),
            };
            return {
                repo,
                service: new MissionsService(
                    repo as unknown as Repository<Mission>,
                    new TitlerService(),
                ),
            };
        }

        it('lists only the active Organization and keeps personal scope compatible with legacy rows', async () => {
            const rows = [
                mission({ id: 'ever', ...EVER_SCOPE }),
                mission({ id: 'other', ...OTHER_SCOPE }),
                mission({
                    id: 'personal-current',
                    tenantId: EVER_SCOPE.tenantId,
                    organizationId: null,
                }),
                mission({ id: 'personal-legacy', tenantId: null, organizationId: null }),
                mission({
                    id: 'personal-foreign',
                    tenantId: FOREIGN_SCOPE.tenantId,
                    organizationId: null,
                }),
            ];
            const { service } = makeService(rows);

            const ever = await (service.listForUser as any)('user-1', {}, EVER_SCOPE);
            const personal = await (service.listForUser as any)('user-1', {}, PERSONAL_SCOPE);

            expect(ever.map((row: { id: string }) => row.id)).toEqual(['ever']);
            expect(personal.map((row: { id: string }) => row.id)).toEqual([
                'personal-current',
                'personal-legacy',
            ]);
        });

        it.each([
            ['another Organization', mission({ id: 'hidden-org', ...OTHER_SCOPE })],
            ['another tenant', mission({ id: 'hidden-tenant', ...FOREIGN_SCOPE })],
        ])('returns the same 404 for a lookup in %s', async (_label, hidden) => {
            const { service } = makeService([hidden]);
            await expect(
                (service.getForUser as any)('user-1', hidden.id, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('create response and subsequent scoped read expose the same ownership', async () => {
            const { service } = makeService([]);
            const created = await service.create('user-1', {
                title: 'Build Ever Works',
                description: 'Build Ever Works safely',
                type: MissionType.ONE_SHOT,
            });
            const read = await (service.getForUser as any)('user-1', created.id, EVER_SCOPE);
            expect(created).toMatchObject(EVER_SCOPE);
            expect(read).toMatchObject(EVER_SCOPE);
        });

        it('does not update a known Mission UUID from another active Organization', async () => {
            const hidden = mission({ id: 'mission-yo', title: 'Yo Mission', ...OTHER_SCOPE });
            const { repo, service } = makeService([hidden]);

            await expect(
                (service.update as any)(
                    'user-1',
                    hidden.id,
                    { title: 'Ever overwrite' },
                    EVER_SCOPE,
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(repo.save).not.toHaveBeenCalled();
            expect(hidden.title).toBe('Yo Mission');
        });
    });

    describe('GoalsService', () => {
        function makeService(rows: Goal[]) {
            const goalsRepo = {
                find: jest.fn(
                    async (options: {
                        where?: FindOptionsWhere<Goal> | FindOptionsWhere<Goal>[];
                    }) =>
                        rows.filter((row) =>
                            matchesWhere(
                                row as unknown as Record<string, unknown>,
                                options.where as never,
                            ),
                        ),
                ),
                findOne: jest.fn(
                    async (options: {
                        where?: FindOptionsWhere<Goal> | FindOptionsWhere<Goal>[];
                    }) =>
                        rows.find((row) =>
                            matchesWhere(
                                row as unknown as Record<string, unknown>,
                                options.where as never,
                            ),
                        ) ?? null,
                ),
                create: jest.fn((partial: Partial<Goal>) => goal(partial)),
                save: jest.fn(async (row: Goal) => {
                    row.tenantId = EVER_SCOPE.tenantId;
                    row.organizationId = EVER_SCOPE.organizationId;
                    const index = rows.findIndex((candidate) => candidate.id === row.id);
                    if (index === -1) rows.push(row);
                    else rows[index] = row;
                    return row;
                }),
            };
            const emptyRepo = { find: jest.fn(async () => []), findOne: jest.fn(async () => null) };
            return new GoalsService(
                goalsRepo as unknown as Repository<Goal>,
                emptyRepo as unknown as Repository<GoalMetricSample>,
                emptyRepo as unknown as Repository<MissionGoal>,
                emptyRepo as unknown as Repository<Mission>,
                { evaluateOne: jest.fn() } as unknown as GoalEvaluationService,
            );
        }

        it('lists only the active Organization and keeps personal scope compatible with legacy rows', async () => {
            const service = makeService([
                goal({ id: 'ever', ...EVER_SCOPE }),
                goal({ id: 'other', ...OTHER_SCOPE }),
                goal({
                    id: 'personal-current',
                    tenantId: EVER_SCOPE.tenantId,
                    organizationId: null,
                }),
                goal({ id: 'personal-legacy', tenantId: null, organizationId: null }),
                goal({
                    id: 'personal-foreign',
                    tenantId: FOREIGN_SCOPE.tenantId,
                    organizationId: null,
                }),
            ]);

            const ever = await (service.listForUser as any)('user-1', {}, EVER_SCOPE);
            const personal = await (service.listForUser as any)('user-1', {}, PERSONAL_SCOPE);

            expect(ever.map((row: { id: string }) => row.id)).toEqual(['ever']);
            expect(personal.map((row: { id: string }) => row.id)).toEqual([
                'personal-current',
                'personal-legacy',
            ]);
        });

        it.each([
            ['another Organization', goal({ id: 'hidden-org', ...OTHER_SCOPE })],
            ['another tenant', goal({ id: 'hidden-tenant', ...FOREIGN_SCOPE })],
        ])('returns the same 404 for a lookup in %s', async (_label, hidden) => {
            const service = makeService([hidden]);
            await expect(
                (service.getForUser as any)('user-1', hidden.id, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('create response and subsequent scoped read expose the same ownership', async () => {
            const service = makeService([]);
            const created = await service.create('user-1', {
                title: 'Ship ownership proof',
                metricSource: { pluginId: 'stripe', metricId: 'income' },
                comparator: 'gte',
                targetValue: 1,
                unit: 'proof',
                window: 'point',
            });
            const read = await (service.getForUser as any)('user-1', created.id, EVER_SCOPE);
            expect(created).toMatchObject(EVER_SCOPE);
            expect(read).toMatchObject(EVER_SCOPE);
        });

        it('does not activate a known Goal UUID from another active Organization', async () => {
            const hidden = goal({ id: 'goal-yo', title: 'Yo Goal', ...OTHER_SCOPE });
            const service = makeService([hidden]);

            await expect(
                (service.activate as any)('user-1', hidden.id, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(hidden.status).toBe(GoalStatus.DRAFT);
        });
    });

    describe('AgentsService', () => {
        function makeService(rows: Agent[]) {
            const agents = {
                findByUserIdScoped: jest.fn(
                    async (userId: string, _filter: unknown, scope?: OwnershipScope) => {
                        const owned = scopedRows(rows, userId, scope);
                        return { rows: owned, total: owned.length };
                    },
                ),
                findByIdAndUser: jest.fn(
                    async (id: string, userId: string, scope?: OwnershipScope) =>
                        scopedRows(rows, userId, scope).find((row) => row.id === id) ?? null,
                ),
                findByUserIdAndSlug: jest.fn(async () => null),
                create: jest.fn(async (partial: Partial<Agent>) => {
                    const saved = agent({ ...partial, ...EVER_SCOPE });
                    rows.push(saved);
                    return saved;
                }),
                archiveById: jest.fn(),
            };
            return new AgentsService(agents as never, {} as never, {} as never);
        }

        it('lists only the active Organization and keeps personal scope compatible with legacy rows', async () => {
            const service = makeService([
                agent({ id: 'ever', ...EVER_SCOPE }),
                agent({ id: 'other', ...OTHER_SCOPE }),
                agent({
                    id: 'personal-current',
                    tenantId: EVER_SCOPE.tenantId,
                    organizationId: null,
                }),
                agent({ id: 'personal-legacy', tenantId: null, organizationId: null }),
                agent({
                    id: 'personal-foreign',
                    tenantId: FOREIGN_SCOPE.tenantId,
                    organizationId: null,
                }),
            ]);

            const ever = await (service.list as any)('user-1', {}, EVER_SCOPE);
            const personal = await (service.list as any)('user-1', {}, PERSONAL_SCOPE);

            expect(ever.rows.map((row: { id: string }) => row.id)).toEqual(['ever']);
            expect(personal.rows.map((row: { id: string }) => row.id)).toEqual([
                'personal-current',
                'personal-legacy',
            ]);
        });

        it.each([
            ['another Organization', agent({ id: 'hidden-org', ...OTHER_SCOPE })],
            ['another tenant', agent({ id: 'hidden-tenant', ...FOREIGN_SCOPE })],
        ])('returns the same 404 for a lookup in %s', async (_label, hidden) => {
            const service = makeService([hidden]);
            await expect(
                (service.getOne as any)('user-1', hidden.id, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('create response and subsequent scoped read expose the same ownership', async () => {
            const service = makeService([]);
            const created = await (service.create as any)(
                'user-1',
                { scope: AgentScope.TENANT, name: 'Ownership verifier' },
                EVER_SCOPE,
            );
            const read = await (service.getOne as any)('user-1', created.id, EVER_SCOPE);
            expect(created).toMatchObject(EVER_SCOPE);
            expect(read).toMatchObject(EVER_SCOPE);
        });

        it('does not archive a known Agent UUID from another active Organization', async () => {
            const hidden = agent({ id: 'agent-yo', name: 'Yo Agent', ...OTHER_SCOPE });
            const service = makeService([hidden]);

            await expect(
                (service.archive as any)('user-1', hidden.id, EVER_SCOPE),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('does not create an Agent with a bulk target from another Organization', async () => {
            const foreignWork = {
                id: 'work-yo',
                userId: 'user-1',
                ...OTHER_SCOPE,
            } as Work;
            const agents = {
                findByUserIdAndSlug: jest.fn(async () => null),
                create: jest.fn(async (partial: Partial<Agent>) => agent(partial)),
            };
            const memberships = { replaceForAgent: jest.fn(async () => undefined) };
            const workRepo = {
                findOne: jest.fn(
                    async (options: {
                        where?: FindOptionsWhere<Work> | FindOptionsWhere<Work>[];
                    }) =>
                        matchesWhere(
                            foreignWork as unknown as Record<string, unknown>,
                            options.where as never,
                        )
                            ? foreignWork
                            : null,
                ),
            };
            const service = new AgentsService(
                agents as never,
                memberships as never,
                {} as never,
                undefined,
                workRepo as unknown as Repository<Work>,
            );

            await expect(
                (service.create as any)(
                    'user-1',
                    {
                        scope: AgentScope.TENANT,
                        name: 'Ever operator',
                        targets: [{ type: 'work', id: foreignWork.id }],
                    },
                    EVER_SCOPE,
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(agents.create).not.toHaveBeenCalled();
        });

        it('does not replace Agent targets with a known Work from another Organization', async () => {
            const ownedAgent = agent({ id: 'agent-ever', ...EVER_SCOPE });
            const foreignWork = {
                id: 'work-yo',
                userId: 'user-1',
                ...OTHER_SCOPE,
            } as Work;
            const agents = {
                findByIdAndUser: jest.fn(async () => ownedAgent),
                findById: jest.fn(async () => ownedAgent),
                updateById: jest.fn(async () => undefined),
            };
            const memberships = { replaceForAgent: jest.fn(async () => undefined) };
            const workRepo = {
                findOne: jest.fn(
                    async (options: {
                        where?: FindOptionsWhere<Work> | FindOptionsWhere<Work>[];
                    }) =>
                        matchesWhere(
                            foreignWork as unknown as Record<string, unknown>,
                            options.where as never,
                        )
                            ? foreignWork
                            : null,
                ),
            };
            const service = new AgentsService(
                agents as never,
                memberships as never,
                {} as never,
                undefined,
                workRepo as unknown as Repository<Work>,
            );

            await expect(
                (service.update as any)(
                    'user-1',
                    ownedAgent.id,
                    { targets: [{ type: 'work', id: foreignWork.id }] },
                    EVER_SCOPE,
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(agents.updateById).not.toHaveBeenCalled();
            expect(memberships.replaceForAgent).not.toHaveBeenCalled();
        });

        it('does not assign an Environment from another Organization', async () => {
            const ownedAgent = agent({ id: 'agent-ever', ...EVER_SCOPE });
            const foreignEnvironment = {
                id: 'environment-yo',
                userId: 'user-1',
                status: 'published',
                ...OTHER_SCOPE,
            };
            const agents = {
                findByIdAndUser: jest.fn(async () => ownedAgent),
                findById: jest.fn(async () => ownedAgent),
                updateById: jest.fn(async () => undefined),
            };
            const environmentRepo = {
                findOne: jest.fn(
                    async (options: {
                        where?:
                            | FindOptionsWhere<typeof foreignEnvironment>
                            | FindOptionsWhere<typeof foreignEnvironment>[];
                    }) =>
                        matchesWhere(foreignEnvironment, options.where) ? foreignEnvironment : null,
                ),
            };
            const service = new AgentsService(
                agents as never,
                { replaceForAgent: jest.fn() } as never,
                {} as never,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                environmentRepo as never,
            );

            await expect(
                (service.update as any)(
                    'user-1',
                    ownedAgent.id,
                    { environmentId: foreignEnvironment.id },
                    EVER_SCOPE,
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(agents.updateById).not.toHaveBeenCalled();
        });
    });

    it('rejects attaching a Work from another Organization without leaking whether it exists', async () => {
        const missionRows = [mission({ id: 'mission-ever', ...EVER_SCOPE })];
        const missionRepo = {
            findOne: jest.fn(
                async (options: { where?: FindOptionsWhere<Mission> }) =>
                    missionRows.find((row) =>
                        matchesWhere(
                            row as unknown as Record<string, unknown>,
                            options.where as never,
                        ),
                    ) ?? null,
            ),
        };
        const foreignWork = {
            id: 'work-other',
            userId: 'user-1',
            ...OTHER_SCOPE,
        } as Work;
        const worksRepo = {
            findOne: jest.fn(async (options: { where?: FindOptionsWhere<Work> }) =>
                matchesWhere(
                    foreignWork as unknown as Record<string, unknown>,
                    options.where as never,
                )
                    ? foreignWork
                    : null,
            ),
        };
        const relations = {
            attach: jest.fn(),
            listForMissionWithWork: jest.fn(async () => []),
        };
        const service = new MissionsService(
            missionRepo as unknown as Repository<Mission>,
            new TitlerService(),
            undefined,
            undefined,
            undefined,
            relations as never,
            worksRepo as unknown as Repository<Work>,
        );

        await expect(
            (service.attachWork as any)(
                'user-1',
                'mission-ever',
                'work-other',
                'operates',
                EVER_SCOPE,
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(relations.attach).not.toHaveBeenCalled();
    });

    it('returns the subscriber-stamped relation ownership and the subsequent scoped read agrees', async () => {
        const ownedMission = mission({ id: 'mission-ever', ...EVER_SCOPE });
        const ownedWork = { id: 'work-ever', userId: 'user-1', ...EVER_SCOPE } as Work;
        const rows: Array<Record<string, unknown>> = [];
        const missionRepo = {
            findOne: jest.fn(async () => ownedMission),
        };
        const worksRepo = {
            findOne: jest.fn(async () => ownedWork),
        };
        const relations = {
            attach: jest.fn(async (input: Record<string, unknown>) => {
                rows.push({ id: 'relation-ever', ...input, ...EVER_SCOPE });
            }),
            listForMissionWithWork: jest.fn(
                async (_missionId: string, _userId: string, activeScope?: OwnershipScope) =>
                    scopedRows(
                        rows as Array<
                            Record<string, unknown> & {
                                userId: string;
                                tenantId: string | null;
                                organizationId: string | null;
                            }
                        >,
                        'user-1',
                        activeScope,
                    ),
            ),
        };
        const service = new MissionsService(
            missionRepo as unknown as Repository<Mission>,
            new TitlerService(),
            undefined,
            undefined,
            undefined,
            relations as never,
            worksRepo as unknown as Repository<Work>,
        );

        const created = await (service.attachWork as any)(
            'user-1',
            ownedMission.id,
            ownedWork.id,
            'operates',
            EVER_SCOPE,
        );
        const read = await (service.listWorks as any)('user-1', ownedMission.id, EVER_SCOPE);

        expect(created[0]).toMatchObject(EVER_SCOPE);
        expect(read[0]).toMatchObject(EVER_SCOPE);
    });
});
