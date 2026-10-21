import { randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Mission } from '../../entities/mission.entity';
import { Team } from '../../entities/team.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import {
    IdeaFailureKind,
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import { RecordVisibilityService } from '../../record-visibility/record-visibility.service';
import { WorkProposalRepository } from '../../user-research/work-proposal.repository';
import { WorkProposalService } from '../../user-research/work-proposal.service';
import {
    AggregateVersionConflictError,
    runExpectingAggregateVersion,
} from '../domain-event-context';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Idea recording points (EW-P2-1): the real `WorkProposalRepository` (the write path
 * every Idea change takes) and `WorkProposalService.createExternal` on SQLite. Each
 * `idea.*` event carries the next `aggregate.version`, and its `data` is valid against
 * the idea schema the catalog names. Integration creates are always `external` +
 * `pending` and never build (spend safety D9).
 */
describe('idea recording points', () => {
    let dataSource: DataSource;
    let repo: WorkProposalRepository;
    let plainRepo: WorkProposalRepository;
    let service: WorkProposalService;
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const KEY = randomUUID();

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const recorder = new DomainEventRecorder();
        const publisher = new DomainEventPublisher(recorder, dataSource);
        repo = new WorkProposalRepository(dataSource.getRepository(WorkProposal), publisher);
        plainRepo = new WorkProposalRepository(dataSource.getRepository(WorkProposal));
        const u = undefined as never;
        service = new WorkProposalService(
            u,
            u,
            u,
            u,
            repo,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            publisher,
            new RecordVisibilityService(dataSource, recorder),
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['work_proposals', 'team_resources', 'missions']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const newTeam = async (slug: string) =>
        dataSource.getRepository(Team).save(
            dataSource.getRepository(Team).create({
                userId: OWNER,
                name: slug,
                slug,
                tenantId: TENANT,
                organizationId: ORG_A,
            } as Partial<Team>),
        );

    const external = (overrides: Record<string, unknown> = {}) =>
        service.createExternal({
            userId: OWNER,
            tenantId: TENANT,
            organizationId: ORG_A,
            title: '  Customer portal  ',
            description: 'Invoices for customers.',
            integrationKeyId: KEY,
            ...overrides,
        });

    it('createExternal stores source external + status pending and records idea.created at version 1', async () => {
        const idea = await external({ status: 'queued', source: 'mission' });
        expect(idea).toMatchObject({
            title: 'Customer portal',
            source: WorkProposalSource.EXTERNAL,
            status: WorkProposalStatus.PENDING,
            createdByType: 'integration',
            createdById: KEY,
            visibility: 'organization',
            visibilityExplicit: false,
        });
        const [event, ...rest] = await events();
        expect(rest).toHaveLength(0);
        expect(event).toMatchObject({
            type: 'idea.created',
            aggregateType: 'idea',
            aggregateId: idea.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
            visibility: 'organization',
        });
        expect(event.data).toMatchObject({
            id: idea.id,
            status: 'pending',
            source: 'external',
            teamIds: [],
            createdBy: { type: 'integration', id: KEY },
            owner: { type: 'user', id: OWNER },
        });
        expectValid(event);
    });

    it('createExternal with teamIds links the Teams and narrows to team (D11) before idea.created', async () => {
        const team = await newTeam('core');
        const idea = await external({ teamIds: [team.id, team.id] });
        const links = await dataSource
            .getRepository(TeamResource)
            .find({ where: { resourceType: 'idea', resourceId: idea.id } });
        expect(links.map((link) => link.teamId)).toEqual([team.id]);
        expect(idea.visibility).toBe('team');
        const recorded = await events();
        // Review 2026-10-17 F34: the Team's own side follows the Idea's event.
        expect(recorded.map((event) => event.type)).toEqual([
            'idea.created',
            'team.resource.added',
        ]);
        expect(recorded[1]).toMatchObject({ aggregateType: 'team', aggregateId: team.id });
        expect(recorded[0].data).toMatchObject({ teamIds: [team.id], visibility: 'team' });
        expectValid(recorded[0]);
    });

    it('createExternal takes team / organization by hand and refuses private with 422 domain_rule', async () => {
        const team = await newTeam('ops');
        const idea = await external({ teamIds: [team.id], visibility: 'organization' });
        expect(idea).toMatchObject({ visibility: 'organization', visibilityExplicit: true });

        await expect(external({ visibility: 'private' })).rejects.toBeInstanceOf(
            UnprocessableEntityException,
        );
        expect(await dataSource.getRepository(WorkProposal).count()).toBe(1);
    });

    it('createExternal runs withinCreate in its transaction: a throw rolls the Idea and its event back', async () => {
        let seen: unknown;
        await expect(
            service.createExternal(
                {
                    userId: OWNER,
                    tenantId: TENANT,
                    organizationId: ORG_A,
                    title: 'Linked',
                    description: 'The externalRef link loses its race.',
                    integrationKeyId: KEY,
                },
                {
                    withinCreate: async (idea, manager) => {
                        seen = await manager.getRepository(WorkProposal).findOneBy({ id: idea.id });
                        throw new Error('the link lost its race');
                    },
                },
            ),
        ).rejects.toThrow('the link lost its race');
        // The row existed inside the transaction, and is gone after it.
        expect(seen).toBeTruthy();
        expect(await dataSource.getRepository(WorkProposal).count()).toBe(0);
        expect(await events()).toEqual([]);
    });

    it('createExternal refuses a Team outside the pinned Organization and writes nothing', async () => {
        await expect(external({ teamIds: [randomUUID()] })).rejects.toThrow('Team not found');
        expect(await dataSource.getRepository(WorkProposal).count()).toBe(0);
        expect(await events()).toHaveLength(0);
    });

    it('dismiss and restore record idea.status_changed with the previous status', async () => {
        const idea = await external();
        expect(await repo.markDismissed(idea.id, OWNER)).toBe(true);
        expect(await service.restore(OWNER, idea.id)).toBe(true);
        // Restore is only from dismissed.
        expect(await service.restore(OWNER, idea.id)).toBe(false);
        const recorded = (await events()).filter((event) => event.type !== 'idea.created');
        expect(
            recorded.map((event) => [event.type, event.aggregateVersion, event.previous]),
        ).toEqual([
            ['idea.status_changed', 2, { status: 'pending' }],
            ['idea.status_changed', 3, { status: 'dismissed' }],
        ]);
        expect(recorded[1].data).toMatchObject({ status: 'pending' });
        for (const event of recorded) expectValid(event);
    });

    it('updateContent records idea.updated with only the changed fields; a no-op records nothing', async () => {
        const idea = await external();
        await service.updateContent(OWNER, idea.id, {
            title: 'Customer portal',
            description: 'Invoices and receipts.',
        });
        await service.updateContent(OWNER, idea.id, { description: 'Invoices and receipts.' });
        const recorded = (await events()).filter((event) => event.type === 'idea.updated');
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            aggregateVersion: 2,
            changedFields: ['description'],
            previous: { description: 'Invoices for customers.' },
        });
        expectValid(recorded[0]);
        // Another owner's Idea reads as missing.
        expect(await service.updateContent(randomUUID(), idea.id, { title: 'x' })).toBeNull();
    });

    it('the build lifecycle records each status move; BUILDING -> BUILDING (auto-retry) records nothing', async () => {
        const idea = await external();
        const workId = randomUUID();
        await repo.markQueuedForBuild(idea.id, OWNER);
        await repo.markBuilding(idea.id, OWNER);
        await repo.markBuilding(idea.id, OWNER);
        await repo.markFailed(idea.id, OWNER, 'boom', IdeaFailureKind.PERMANENT_UNKNOWN);
        await repo.markQueuedForBuild(idea.id, OWNER);
        await repo.markBuilding(idea.id, OWNER);
        await repo.markAccepted(idea.id, OWNER, workId, [WorkProposalStatus.BUILDING]);
        await repo.markRebuildingFromAccepted(idea.id, OWNER);
        const recorded = (await events()).filter((event) => event.type !== 'idea.created');
        expect(recorded.map((event) => (event.data as { status: string }).status)).toEqual([
            'queued',
            'building',
            'failed',
            'queued',
            'building',
            'accepted',
            'building',
        ]);
        expect(recorded.map((event) => event.aggregateVersion)).toEqual([2, 3, 4, 5, 6, 7, 8]);
        expect(recorded[2]).toMatchObject({
            changedFields: ['status', 'failureMessage', 'failureKind'],
            previous: { status: 'building' },
        });
        expect(recorded[2].data).toMatchObject({ failureMessage: 'boom' });
        expect(recorded[5].data).toMatchObject({ acceptedWorkId: workId });
        for (const event of recorded) expectValid(event);
    });

    it('a refused transition records nothing', async () => {
        const idea = await external();
        expect(await repo.markRebuildingFromAccepted(idea.id, OWNER)).toBe(false);
        expect(await repo.markDismissed(idea.id, randomUUID())).toBe(false);
        expect((await events()).map((event) => event.type)).toEqual(['idea.created']);
    });

    it('delete records idea.deleted with the last snapshot at a version claimed first', async () => {
        const idea = await external();
        expect(await repo.deleteForUser(idea.id, randomUUID())).toBe(false);
        expect(await repo.deleteForUser(idea.id, OWNER)).toBe(true);
        const deleted = (await events()).find((event) => event.type === 'idea.deleted');
        expect(deleted).toMatchObject({ aggregateId: idea.id, aggregateVersion: 2 });
        expect(deleted?.data).toMatchObject({
            id: idea.id,
            deleted: true,
            title: 'Customer portal',
        });
        expectValid(deleted!);
        expect(await dataSource.getRepository(WorkProposal).findOneBy({ id: idea.id })).toBeNull();
    });

    it('platform creates record idea.created (bulk generation, + Add)', async () => {
        const [generated] = await repo.bulkInsert([
            {
                userId: OWNER,
                title: 'Generated',
                description: 'From research.',
                slugSuggestion: 'generated',
                suggestedCategories: [],
                suggestedFields: [],
                recommendedPlugins: [],
                generatedPrompt: 'From research.',
                reasoning: 'test',
                source: WorkProposalSource.USER_REFRESH,
            },
        ]);
        const manual = await repo.createUserManual({
            userId: OWNER,
            title: 'Typed',
            description: 'By hand.',
            slugSuggestion: 'typed',
        });
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateId])).toEqual([
            ['idea.created', generated.id],
            ['idea.created', manual.id],
        ]);
    });

    const newMission = async (
        organizationId: string,
        visibility = 'organization',
        userId: string = OWNER,
    ) =>
        dataSource.getRepository(Mission).save(
            dataSource.getRepository(Mission).create({
                userId,
                title: 'Grow',
                description: 'Grow the customer base.',
                type: 'one-shot',
                status: 'paused',
                tenantId: TENANT,
                organizationId,
                visibility,
            } as unknown as Partial<Mission>),
        );

    it("createExternal links the caller's Mission of the pinned Organization; a foreign, private or someone else's one is 404 and writes nothing", async () => {
        const mission = await newMission(ORG_A);
        const idea = await external({ missionId: mission.id });
        expect(idea.missionId).toBe(mission.id);
        const [created] = await events();
        expect(created.data).toMatchObject({ missionId: mission.id });

        const foreign = await newMission(randomUUID());
        const secret = await newMission(ORG_A, 'private');
        // Someone else's Mission, even organization-visible: owner-scoped writes (404).
        const others = await newMission(ORG_A, 'organization', randomUUID());
        for (const missionId of [foreign.id, secret.id, others.id, randomUUID()]) {
            await expect(external({ missionId })).rejects.toThrow('Mission not found');
        }
        expect(await dataSource.getRepository(WorkProposal).count()).toBe(1);
        expect(await events()).toHaveLength(1);
    });

    it('createExternal attributes an act-as create to the person', async () => {
        const PERSON = randomUUID();
        const idea = await external({ userId: PERSON, createdBy: { type: 'user', id: PERSON } });
        expect(idea).toMatchObject({ userId: PERSON, createdByType: 'user', createdById: PERSON });
        const [created] = await events();
        expect(created.data).toMatchObject({
            owner: { type: 'user', id: PERSON },
            createdBy: { type: 'user', id: PERSON },
        });
    });

    it('updateContent under a stale If-Match version rolls the edit back with its event', async () => {
        const idea = await external();
        await expect(
            runExpectingAggregateVersion({ aggregateType: 'idea', id: idea.id, version: 7 }, () =>
                service.updateContent(OWNER, idea.id, { title: 'Stale edit' }),
            ),
        ).rejects.toBeInstanceOf(AggregateVersionConflictError);
        const row = await dataSource.getRepository(WorkProposal).findOneBy({ id: idea.id });
        expect(row).toMatchObject({ title: 'Customer portal', version: 1 });
        expect((await events()).map((event) => event.type)).toEqual(['idea.created']);

        await runExpectingAggregateVersion({ aggregateType: 'idea', id: idea.id, version: 1 }, () =>
            service.updateContent(OWNER, idea.id, { title: 'Fresh edit' }),
        );
        expect(
            await dataSource.getRepository(WorkProposal).findOneBy({ id: idea.id }),
        ).toMatchObject({ title: 'Fresh edit', version: 2 });
    });

    it('without the publisher the repository behaves as before and records nothing', async () => {
        const idea = await external();
        await resetDomainEventsTables(dataSource);
        expect(await plainRepo.markDismissed(idea.id, OWNER)).toBe(true);
        expect(await plainRepo.markRestored(idea.id, OWNER)).toBe(true);
        expect(await plainRepo.deleteForUser(idea.id, OWNER)).toBe(true);
        expect(await events()).toHaveLength(0);
    });
});
