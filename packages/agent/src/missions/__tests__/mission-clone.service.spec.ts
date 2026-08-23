import { NotFoundException } from '@nestjs/common';
import type { FindOptionsWhere, Repository } from 'typeorm';
import { MissionCloneService } from '../mission-clone.service';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';

/**
 * In-memory store shared between the Mission + WorkProposal repos
 * AND the `manager.transaction(...)` callback. Real TypeORM hands
 * a tx-scoped EntityManager into the callback; here we stub it so
 * the same store is read/written regardless of which path the
 * service uses.
 */
function makeStore() {
    const missions: Mission[] = [];
    const proposals: WorkProposal[] = [];
    let missionCounter = 0;
    let proposalCounter = 0;

    function nextMissionId(): string {
        return `m${++missionCounter}`;
    }
    function nextProposalId(): string {
        return `p${++proposalCounter}`;
    }

    function createMissionEntity(partial: Partial<Mission>): Mission {
        return {
            id: partial.id ?? nextMissionId(),
            createdAt: new Date('2026-05-24'),
            updatedAt: new Date('2026-05-24'),
            ...partial,
        } as Mission;
    }
    function createProposalEntity(partial: Partial<WorkProposal>): WorkProposal {
        return {
            id: partial.id ?? nextProposalId(),
            generatedAt: new Date('2026-05-24'),
            ...partial,
        } as WorkProposal;
    }

    function matchesWhere(
        row: Record<string, unknown>,
        where:
            | FindOptionsWhere<Record<string, unknown>>
            | FindOptionsWhere<Record<string, unknown>>[],
    ): boolean {
        if (Array.isArray(where)) return where.some((branch) => matchesWhere(row, branch));
        return Object.entries(where).every(([key, expected]) => {
            if (
                typeof expected === 'object' &&
                expected !== null &&
                (expected as { _type?: string })._type === 'isNull'
            ) {
                return row[key] == null;
            }
            if (
                typeof expected === 'object' &&
                expected !== null &&
                (expected as { _type?: string })._type === 'not'
            ) {
                return row[key] !== (expected as { _value?: unknown })._value;
            }
            return row[key] === expected;
        });
    }

    const txManager = {
        findOne: jest.fn(
            async (
                entity: unknown,
                opts: {
                    where: FindOptionsWhere<Mission> | FindOptionsWhere<Mission>[];
                },
            ) => {
                if (entity === Mission) {
                    return (
                        missions.find((m) => matchesWhere(m as never, opts.where as never)) ?? null
                    );
                }
                return null;
            },
        ),
        find: jest.fn(
            async (
                entity: unknown,
                opts: {
                    where: FindOptionsWhere<WorkProposal> | FindOptionsWhere<WorkProposal>[];
                },
            ) => {
                if (entity === WorkProposal) {
                    return proposals.filter((p) => matchesWhere(p as never, opts.where as never));
                }
                return [];
            },
        ),
        create: jest.fn((entity: unknown, partial: Partial<Mission | WorkProposal>) => {
            if (entity === Mission) return createMissionEntity(partial as Partial<Mission>);
            if (entity === WorkProposal)
                return createProposalEntity(partial as Partial<WorkProposal>);
            throw new Error(`unsupported entity in create()`);
        }),
        save: jest.fn(
            async (
                entityOrRows: unknown,
                maybeRows?: WorkProposal[] | WorkProposal,
            ): Promise<unknown> => {
                // Two-arg form: save(WorkProposal, [rows])
                if (entityOrRows === WorkProposal) {
                    const rows = Array.isArray(maybeRows) ? maybeRows : [maybeRows as WorkProposal];
                    proposals.push(...rows);
                    return rows;
                }
                // Single-arg form: save(mission)
                const m = entityOrRows as Mission;
                missions.push(m);
                return m;
            },
        ),
    };

    return {
        missions,
        proposals,
        txManager,
        matchesWhere,
        seedMission(partial: Partial<Mission> & { userId: string }): Mission {
            const m: Mission = createMissionEntity({
                title: 'src title',
                description: 'src description',
                type: MissionType.SCHEDULED,
                status: MissionStatus.ACTIVE,
                schedule: '0 9 * * MON',
                autoBuildWorks: true,
                outstandingIdeasCap: 7,
                guardrailsOverride: null,
                missionTemplateRepo: 'ever-works/template-mission',
                missionRepo: 'ever-works/source-mission',
                sourceMissionId: null,
                ...partial,
            });
            missions.push(m);
            return m;
        },
        seedProposal(
            partial: Partial<WorkProposal> & { userId: string; missionId: string },
        ): WorkProposal {
            const p: WorkProposal = createProposalEntity({
                title: 'src idea',
                description: 'src idea desc',
                slugSuggestion: 'src-idea',
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                generatedPrompt: 'prompt',
                reasoning: 'reasoning',
                source: WorkProposalSource.MISSION,
                status: WorkProposalStatus.PENDING,
                ...partial,
            });
            proposals.push(p);
            return p;
        },
    };
}

function makeRepos(store: ReturnType<typeof makeStore>) {
    const missionRepo = {
        manager: {
            transaction: jest.fn(async <T>(cb: (tx: typeof store.txManager) => Promise<T>) => {
                return cb(store.txManager);
            }),
        },
        count: jest.fn(
            async (opts: { where: FindOptionsWhere<Mission> | FindOptionsWhere<Mission>[] }) =>
                store.missions.filter((mission) =>
                    store.matchesWhere(mission as never, opts.where as never),
                ).length,
        ),
    };
    const proposalRepo = {};
    return { missionRepo, proposalRepo };
}

describe('MissionCloneService', () => {
    let store: ReturnType<typeof makeStore>;
    let repos: ReturnType<typeof makeRepos>;
    let service: MissionCloneService;

    beforeEach(() => {
        store = makeStore();
        repos = makeRepos(store);
        service = new MissionCloneService(
            repos.missionRepo as unknown as Repository<Mission>,
            repos.proposalRepo as unknown as Repository<WorkProposal>,
        );
    });

    describe('cloneForUser', () => {
        it('copies the source Mission metadata into a new Mission with sourceMissionId set', async () => {
            const source = store.seedMission({ userId: 'u1' });
            const result = await service.cloneForUser('u1', source.id);

            // New row was created.
            expect(store.missions).toHaveLength(2);
            const cloned = store.missions[1];
            expect(cloned.id).not.toBe(source.id);
            expect(cloned.sourceMissionId).toBe(source.id);
            // Metadata copied verbatim.
            expect(cloned.description).toBe(source.description);
            expect(cloned.type).toBe(source.type);
            expect(cloned.schedule).toBe(source.schedule);
            expect(cloned.autoBuildWorks).toBe(source.autoBuildWorks);
            expect(cloned.outstandingIdeasCap).toBe(source.outstandingIdeasCap);
            expect(cloned.missionTemplateRepo).toBe(source.missionTemplateRepo);
            // Always ACTIVE on clone — regardless of source status.
            expect(cloned.status).toBe(MissionStatus.ACTIVE);
            // Repo is NULLed; the scaffolder (Phase 8 PR X) will mint one.
            expect(cloned.missionRepo).toBeNull();
            // Default title is "Copy of <source>".
            expect(cloned.title).toBe(`Copy of ${source.title}`);
            // Result envelope reflects what was done.
            expect(result.mission.sourceMissionId).toBe(source.id);
            expect(result.ideasCloned).toBe(0);
            expect(result.ideasSkipped).toBe(0);
        });

        it('honors the optional title override and clips to 200 chars', async () => {
            const source = store.seedMission({ userId: 'u1' });
            const customTitle = 'My Custom Clone Title';
            const longTitle = 'x'.repeat(300);
            const result1 = await service.cloneForUser('u1', source.id, { title: customTitle });
            expect(result1.mission.title).toBe(customTitle);
            const result2 = await service.cloneForUser('u1', source.id, { title: longTitle });
            expect(result2.mission.title.length).toBe(200);
        });

        it('clones non-DISMISSED Ideas as PENDING with fresh ids and the new missionId', async () => {
            const source = store.seedMission({ userId: 'u1' });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'A',
                slugSuggestion: 'a',
                status: WorkProposalStatus.PENDING,
            });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'B',
                slugSuggestion: 'b',
                status: WorkProposalStatus.ACCEPTED,
                acceptedWorkId: 'work-from-B',
                failureMessage: null,
            });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'C',
                slugSuggestion: 'c',
                status: WorkProposalStatus.FAILED,
                failureMessage: 'old error',
            });

            const result = await service.cloneForUser('u1', source.id);
            expect(result.ideasCloned).toBe(3);
            expect(result.ideasSkipped).toBe(0);

            const newMissionId = result.mission.id;
            const newIdeas = store.proposals.filter((p) => p.missionId === newMissionId);
            expect(newIdeas).toHaveLength(3);
            // All cloned Ideas are PENDING regardless of source status.
            for (const idea of newIdeas) {
                expect(idea.status).toBe(WorkProposalStatus.PENDING);
                expect(idea.source).toBe(WorkProposalSource.MISSION);
                expect(idea.failureMessage).toBeNull();
                expect(idea.failureKind).toBeNull();
                expect(idea.acceptedWorkId).toBeNull();
                // Fresh ids — not the same as the source rows.
                expect(idea.id).not.toEqual(expect.stringMatching(/^p[123]$/));
            }
            // Content carried over (titles preserved).
            const titles = newIdeas.map((i) => i.title).sort();
            expect(titles).toEqual(['A', 'B', 'C']);
        });

        it('skips DISMISSED Ideas and reports the skipped count', async () => {
            const source = store.seedMission({ userId: 'u1' });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'A',
                slugSuggestion: 'a',
                status: WorkProposalStatus.PENDING,
            });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'B',
                slugSuggestion: 'b',
                status: WorkProposalStatus.DISMISSED,
            });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'C',
                slugSuggestion: 'c',
                status: WorkProposalStatus.DISMISSED,
            });

            const result = await service.cloneForUser('u1', source.id);
            expect(result.ideasCloned).toBe(1);
            expect(result.ideasSkipped).toBe(2);
            const cloned = store.proposals.filter((p) => p.missionId === result.mission.id);
            expect(cloned).toHaveLength(1);
            expect(cloned[0].title).toBe('A');
        });

        it('does NOT touch the source Mission rows (Ideas + metadata)', async () => {
            const source = store.seedMission({ userId: 'u1' });
            const sourceIdea = store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'Original',
                slugSuggestion: 'original',
                status: WorkProposalStatus.ACCEPTED,
                acceptedWorkId: 'w-orig',
            });
            await service.cloneForUser('u1', source.id);
            // Source mission still exists with same title and missionRepo.
            expect(store.missions[0]).toEqual(source);
            // Source idea still ACCEPTED with its original work.
            expect(sourceIdea.status).toBe(WorkProposalStatus.ACCEPTED);
            expect(sourceIdea.acceptedWorkId).toBe('w-orig');
        });

        it('throws NotFoundException when the Mission belongs to another user', async () => {
            const source = store.seedMission({ userId: 'alice' });
            await expect(service.cloneForUser('bob', source.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws NotFoundException when the Mission id does not exist', async () => {
            await expect(
                service.cloneForUser('u1', '00000000-0000-0000-0000-000000000000'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('does not clone a known Mission UUID from another active Organization', async () => {
            const everScope = {
                tenantId: '11111111-1111-4111-8111-111111111111',
                organizationId: '22222222-2222-4222-8222-222222222222',
            };
            const source = store.seedMission({
                userId: 'u1',
                tenantId: everScope.tenantId,
                organizationId: '33333333-3333-4333-8333-333333333333',
            });

            await expect(
                (service.cloneForUser as any)('u1', source.id, {}, everScope),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(store.missions).toEqual([source]);
        });

        it('copies only Ideas from the active Organization and stamps the clone exactly', async () => {
            const everScope = {
                tenantId: '11111111-1111-4111-8111-111111111111',
                organizationId: '22222222-2222-4222-8222-222222222222',
            };
            const source = store.seedMission({ userId: 'u1', ...everScope });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'Ever idea',
                ...everScope,
            });
            store.seedProposal({
                userId: 'u1',
                missionId: source.id,
                title: 'Yo idea',
                tenantId: everScope.tenantId,
                organizationId: '33333333-3333-4333-8333-333333333333',
            });

            const result = await (service.cloneForUser as any)('u1', source.id, {}, everScope);
            const copies = store.proposals.filter((idea) => idea.missionId === result.mission.id);

            expect(result.mission).toMatchObject(everScope);
            expect(copies).toHaveLength(1);
            expect(copies[0]).toMatchObject({ title: 'Ever idea', ...everScope });
        });
    });

    describe('countClonesOf', () => {
        it('returns 0 when nothing clones the given Mission', async () => {
            const source = store.seedMission({ userId: 'u1' });
            expect(await service.countClonesOf('u1', source.id)).toBe(0);
        });

        it('counts Missions pointing at the given source via sourceMissionId', async () => {
            const source = store.seedMission({ userId: 'u1' });
            await service.cloneForUser('u1', source.id);
            await service.cloneForUser('u1', source.id);
            expect(await service.countClonesOf('u1', source.id)).toBe(2);
        });
    });
});
