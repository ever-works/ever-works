import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Mission } from '../../entities/mission.entity';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Task } from '../../entities/task.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { TaskReviewer } from '../../entities/task-reviewer.entity';
import { TaskWatcher } from '../../entities/task-watcher.entity';
import { Team } from '../../entities/team.entity';
import { TeamMember } from '../../entities/team-member.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkProposal } from '../../entities/work-proposal.entity';
import { TeamResourcesService } from '../../teams/team-resources.service';
import { TeamsService } from '../../teams/teams.service';
import { RecordAccessPolicy } from '../../record-visibility/record-access-policy.service';
import { RecordVisibilityService } from '../../record-visibility/record-visibility.service';
import { Goal } from '../../entities/goal.entity';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import { buildTeamSnapshot } from '../domain-event-snapshots';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Team recording points (EW-P1-1 B2, spec §3–4): the real `TeamsService` and
 * `TeamResourcesService` on SQLite. Every write records its `team.*` event in
 * the write's transaction, versions move as the spec says, and each event's
 * `data` is valid against the schema its catalog row names.
 */
describe('team recording points', () => {
    let dataSource: DataSource;
    let teams: TeamsService;
    let plainTeams: TeamsService;
    let resources: TeamResourcesService;
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const AGENT = randomUUID();
    const TASK = randomUUID();

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });
    const versionOf = async (entity: typeof Team | typeof Task, id: string) =>
        Number(
            (
                (await dataSource.getRepository(entity).findOneByOrFail({ id })) as {
                    version: number;
                }
            ).version,
        );

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const repo = <T extends object>(entity: new () => T) => dataSource.getRepository(entity);
        const publisher = new DomainEventPublisher(new DomainEventRecorder(), dataSource);
        const visibility = new RecordVisibilityService(dataSource, new DomainEventRecorder());
        teams = new TeamsService(
            repo(Team),
            repo(TeamMember),
            repo(Agent),
            repo(Organization),
            repo(User),
            publisher,
            // Record visibility (EW-P1-3), wired as in production: the automatic
            // team / organization change lands before the side snapshots.
            visibility,
        );
        plainTeams = new TeamsService(
            repo(Team),
            repo(TeamMember),
            repo(Agent),
            repo(Organization),
            repo(User),
        );
        resources = new TeamResourcesService(
            repo(TeamResource),
            repo(Team),
            repo(Organization),
            repo(Work),
            repo(Agent),
            repo(Mission),
            repo(WorkProposal),
            repo(Task),
            publisher,
            repo(Goal),
            visibility,
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of [
            'organizations',
            'agents',
            'team_members',
            'team_resources',
            'tasks',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        await dataSource.getRepository(Organization).insert({
            id: ORG_A,
            tenantId: TENANT,
            slug: `org-${randomUUID().slice(0, 8)}`,
            displayName: 'Acme',
        });
        await dataSource.getRepository(Agent).insert({
            id: AGENT,
            userId: OWNER,
            scope: 'tenant',
            name: 'Builder',
            slug: 'builder',
            permissions: {},
            tenantId: TENANT,
            organizationId: ORG_A,
        } as unknown as Agent);
        await dataSource.getRepository(Task).insert({
            id: TASK,
            userId: OWNER,
            slug: 'T-1',
            title: 'Ship the feed',
            createdByType: 'user',
            createdById: OWNER,
            tenantId: TENANT,
            organizationId: ORG_A,
        } as unknown as Task);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const newTeam = (name = 'Platform') => teams.create(OWNER, ORG_A, { name });

    it('create records team.created at version 1 with a valid team DTO', async () => {
        const team = await newTeam();
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'team.created',
            aggregateType: 'team',
            aggregateId: team.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
        });
        expect(event.data).toMatchObject({ id: team.id, name: 'Platform', version: 1 });
        expectValid(event);
    });

    it('update records team.updated with only the changed fields and their previous values', async () => {
        const team = await newTeam();
        const returned = await teams.update(ORG_A, team.id, {
            name: 'Platform Core',
            description: null,
        });
        expect(returned.version).toBe(2);
        const updated = (await events()).find((event) => event.type === 'team.updated');
        expect(updated).toMatchObject({
            aggregateVersion: 2,
            changedFields: ['name'],
            previous: { name: 'Platform' },
        });
        expect(updated?.data).toMatchObject({ name: 'Platform Core', version: 2 });
        expectValid(updated!);
        expect(await versionOf(Team, team.id)).toBe(2);
    });

    // Review 2026-10-17 F7 (P1) / F29: the copy `update` loaded must not write its
    // `version` back over a concurrent bump (a member added meanwhile).
    it('update never writes back a stale version: the bump continues from the current one', async () => {
        const team = await newTeam();
        const stale = await dataSource.getRepository(Team).findOneByOrFail({ id: team.id });
        // A concurrent child change moved the team to version 3 after `stale` was read.
        await dataSource.getRepository(Team).update({ id: team.id }, { version: 3 });
        jest.spyOn(dataSource.getRepository(Team), 'findOne').mockResolvedValueOnce(stale);

        const returned = await teams.update(ORG_A, team.id, { name: 'Platform Core' });

        expect(returned.version).toBe(4);
        expect(await versionOf(Team, team.id)).toBe(4);
        const updated = (await events()).find((event) => event.type === 'team.updated');
        expect(updated?.aggregateVersion).toBe(4);
    });

    it('roster changes record team.member.* child events that bump the team version', async () => {
        const team = await newTeam();
        await teams.addMember(OWNER, ORG_A, team.id, {
            memberType: 'agent',
            memberId: AGENT,
            role: 'lead',
        });
        await teams.removeMember(ORG_A, team.id, 'agent', AGENT);
        const roster = (await events()).filter((event) => event.type.startsWith('team.member.'));
        expect(roster.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['team.member.added', 2],
            ['team.member.removed', 3],
        ]);
        expect(roster[0].data).toEqual({
            teamId: team.id,
            memberType: 'agent',
            memberId: AGENT,
            role: 'lead',
        });
        expect(roster[1].data).toMatchObject({ memberId: AGENT, role: 'lead', deleted: true });
        for (const event of roster) {
            expect(event.changedFields).toEqual(['members']);
            expectValid(event);
        }
        expect(await versionOf(Team, team.id)).toBe(3);
        // The agent's team scope moved with each roster change.
        const agentSide = (await events()).filter((event) => event.aggregateId === AGENT);
        expect(agentSide.map((event) => [event.type, event.changedFields])).toEqual([
            ['agent.updated', ['teamIds']],
            ['agent.updated', ['teamIds']],
        ]);
        expect(agentSide[0].data).toMatchObject({ teamIds: [team.id], visibility: 'team' });
        expect(agentSide[1].data).toMatchObject({ teamIds: [], visibility: 'organization' });
        for (const event of agentSide) expectValid(event);
    });

    it('a resource attach records team.resource.added and the task side event', async () => {
        const team = await newTeam();
        await resources.attach(OWNER, ORG_A, team.id, { resourceType: 'task', resourceId: TASK });
        await resources.detach(ORG_A, team.id, 'task', TASK);
        const recorded = (await events()).filter((event) => event.type !== 'team.created');
        expect(recorded.map((event) => [event.type, event.aggregateId])).toEqual([
            ['team.resource.added', team.id],
            ['task.updated', TASK],
            ['team.resource.removed', team.id],
            ['task.updated', TASK],
        ]);
        expect(recorded[1]).toMatchObject({ changedFields: ['teamIds'] });
        expect(recorded[1].data).toMatchObject({ teamIds: [team.id], visibility: 'team' });
        expect(recorded[3].data).toMatchObject({ teamIds: [], visibility: 'organization' });
        for (const event of recorded) expectValid(event);
        expect(await versionOf(Task, TASK)).toBe(3);
    });

    describe('private records on a Team (review 2026-10-17 F4)', () => {
        const OTHER = randomUUID();
        const repo = <T extends object>(entity: new () => T) => dataSource.getRepository(entity);
        const policy = () =>
            new RecordAccessPolicy(
                repo(OrganizationMember),
                repo(Organization),
                repo(Tenant),
                repo(TeamMember),
                repo(Team),
                repo(WorkMember),
                repo(Work),
                repo(TaskAssignee),
                repo(TaskApprover),
                repo(TaskReviewer),
                repo(TaskWatcher),
                repo(Task),
                repo(Goal),
                repo(Mission),
                repo(WorkProposal),
                repo(Agent),
            );
        const withPolicy = () =>
            new TeamResourcesService(
                repo(TeamResource),
                repo(Team),
                repo(Organization),
                repo(Work),
                repo(Agent),
                repo(Mission),
                repo(WorkProposal),
                repo(Task),
                new DomainEventPublisher(new DomainEventRecorder(), dataSource),
                repo(Goal),
                new RecordVisibilityService(dataSource, new DomainEventRecorder()),
                policy(),
            );
        const makePrivate = () =>
            repo(Task).update({ id: TASK }, { visibility: 'private', visibilityExplicit: true });
        const listed = async (
            service: TeamResourcesService,
            teamId: string,
            viewer?: Parameters<TeamResourcesService['listForTeam']>[2],
        ) => (await service.listForTeam(ORG_A, teamId, viewer)).task.map((item) => item.resourceId);

        beforeEach(async () => {
            await dataSource.query('DELETE FROM "organization_members"');
            await repo(OrganizationMember).insert({
                organizationId: ORG_A,
                tenantId: TENANT,
                userId: OTHER,
                role: 'member',
                invitedById: null,
                invitationId: null,
                joinedAt: new Date(),
            } as unknown as OrganizationMember);
        });

        it('lists a private task to its owner only, never to an integration', async () => {
            const team = await newTeam();
            const service = withPolicy();
            await service.attach(OWNER, ORG_A, team.id, { resourceType: 'task', resourceId: TASK });
            await makePrivate();

            expect(await listed(service, team.id, { kind: 'user', userId: OWNER })).toEqual([TASK]);
            expect(await listed(service, team.id, { kind: 'user', userId: OTHER })).toEqual([]);
            expect(await listed(service, team.id, { kind: 'integration' })).toEqual([]);
            // No viewer (and no read policy): a private record is still never listed.
            expect(await listed(resources, team.id)).toEqual([]);
        });

        it('lists a Team-only task only to a member of a Team that reaches it', async () => {
            const team = await newTeam();
            const service = withPolicy();
            await service.attach(OWNER, ORG_A, team.id, { resourceType: 'task', resourceId: TASK });
            // Automatic visibility: the task's first Team made it `team`.
            expect((await repo(Task).findOneByOrFail({ id: TASK })).visibility).toBe('team');
            expect(await listed(service, team.id, { kind: 'user', userId: OTHER })).toEqual([]);
            expect(await listed(service, team.id, { kind: 'integration' })).toEqual([TASK]);

            await repo(TeamMember).insert({
                teamId: team.id,
                memberType: 'user',
                memberId: OTHER,
                tenantId: TENANT,
                organizationId: ORG_A,
            } as unknown as TeamMember);
            expect(await listed(withPolicy(), team.id, { kind: 'user', userId: OTHER })).toEqual([
                TASK,
            ]);
        });

        it("keeps a private record out of the Team DTO and off the feed, and an integration can't attach it", async () => {
            const team = await newTeam();
            await makePrivate();
            await expect(
                resources.attach(
                    OWNER,
                    ORG_A,
                    team.id,
                    { resourceType: 'task', resourceId: TASK },
                    { viewer: { kind: 'integration' } },
                ),
            ).rejects.toBeInstanceOf(NotFoundException);

            // The owner may still put their private task on a Team.
            await resources.attach(OWNER, ORG_A, team.id, {
                resourceType: 'task',
                resourceId: TASK,
            });
            const added = (await events()).find((event) => event.type === 'team.resource.added');
            expect(added?.visibility).toBe('private');
            const snapshot = await buildTeamSnapshot(dataSource.manager, team.id);
            expect(snapshot?.dto.resources).toEqual([]);

            await resources.detach(ORG_A, team.id, 'task', TASK);
            const removed = (await events()).find(
                (event) => event.type === 'team.resource.removed',
            );
            expect(removed?.visibility).toBe('private');
        });
    });

    // Review 2026-10-17 F34: a record's `teamIds` written through RecordVisibilityService
    // moves the Teams' resources too, so each Team records it and its version moves.
    it("setTeams records the Teams' side: team.resource.added / removed with a team version bump (F34)", async () => {
        const visibility = new RecordVisibilityService(dataSource, new DomainEventRecorder());
        const first = await newTeam('First');
        const second = await newTeam('Second');
        await visibility.setTeams('task', TASK, [first.id, second.id], OWNER);
        // `teamId` (the first) is a task column; the second is a `team_resources` row.
        const added = (await events()).filter((event) => event.type === 'team.resource.added');
        expect(added.map((event) => [event.aggregateId, event.aggregateVersion])).toEqual([
            [second.id, 2],
        ]);
        expect(added[0].data).toMatchObject({
            teamId: second.id,
            resourceType: 'task',
            resourceId: TASK,
        });
        expectValid(added[0]);
        expect(await versionOf(Team, second.id)).toBe(2);

        await visibility.setTeams('task', TASK, [first.id], OWNER);
        const removed = (await events()).filter((event) => event.type === 'team.resource.removed');
        expect(removed.map((event) => [event.aggregateId, event.aggregateVersion])).toEqual([
            [second.id, 3],
        ]);
        expect(removed[0].data).toMatchObject({ resourceId: TASK, deleted: true });
        expectValid(removed[0]);
    });

    // Review 2026-10-17 F35: the DTO carries `visibilityExplicit`, so a change of only that
    // flag moves the version and reaches the feed.
    it('a change of only visibilityExplicit records <aggregate>.updated and bumps the version (F35)', async () => {
        const visibility = new RecordVisibilityService(dataSource, new DomainEventRecorder());
        await dataSource
            .getRepository(Task)
            .update({ id: TASK }, { visibility: 'organization', visibilityExplicit: false });
        const before = await versionOf(Task, TASK);
        await visibility.setVisibility('task', TASK, 'organization');
        const updated = (await events()).filter((event) => event.type === 'task.updated');
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({
            aggregateVersion: before + 1,
            changedFields: ['visibilityExplicit'],
            previous: { visibilityExplicit: false },
        });
        expect(updated[0].data).toMatchObject({ visibilityExplicit: true });
        expect(await versionOf(Task, TASK)).toBe(before + 1);
        // Back to automatic with the same value: the flag moves again.
        await visibility.setVisibility('task', TASK, 'automatic');
        expect((await events()).filter((event) => event.type === 'task.updated')).toHaveLength(2);
    });

    // Review 2026-10-17 F38: a private agent's membership is never served either.
    it('keeps a private agent out of the Team DTO members and its membership events off the feed (F38)', async () => {
        const team = await newTeam();
        await dataSource
            .getRepository(Agent)
            .update({ id: AGENT }, { visibility: 'private', visibilityExplicit: true } as never);
        await teams.addMember(OWNER, ORG_A, team.id, { memberType: 'agent', memberId: AGENT });
        const added = (await events()).find((event) => event.type === 'team.member.added');
        expect(added?.visibility).toBe('private');
        const snapshot = await buildTeamSnapshot(dataSource.manager, team.id);
        expect(snapshot?.dto.members).toEqual([]);
        await teams.removeMember(ORG_A, team.id, 'agent', AGENT);
        const removed = (await events()).find((event) => event.type === 'team.member.removed');
        expect(removed?.visibility).toBe('private');
    });

    it('delete records a team.deleted tombstone at a version claimed before the delete', async () => {
        const team = await newTeam();
        await teams.remove(ORG_A, team.id);
        const deleted = (await events()).find((event) => event.type === 'team.deleted');
        expect(deleted).toMatchObject({ aggregateId: team.id, aggregateVersion: 2 });
        expect(deleted?.data).toMatchObject({ id: team.id, version: 2, deleted: true });
        expectValid(deleted!);
        expect(await dataSource.getRepository(Team).findOneBy({ id: team.id })).toBeNull();
    });

    it('delete also records what it changes: re-parented children and everything losing the team', async () => {
        const parent = await newTeam('Engineering');
        const team = await teams.create(OWNER, ORG_A, {
            name: 'Platform',
            parentTeamId: parent.id,
        });
        const child = await teams.create(OWNER, ORG_A, { name: 'Runtime', parentTeamId: team.id });
        await teams.addMember(OWNER, ORG_A, team.id, { memberType: 'agent', memberId: AGENT });
        await resources.attach(OWNER, ORG_A, team.id, { resourceType: 'task', resourceId: TASK });
        const before = (await events()).length;

        await teams.remove(ORG_A, team.id);

        const recorded = (await events()).slice(before);
        expect(recorded.map((event) => [event.type, event.aggregateId])).toEqual([
            ['team.deleted', team.id],
            ['team.updated', child.id],
            ['agent.updated', AGENT],
            ['task.updated', TASK],
        ]);
        expect(recorded[1]).toMatchObject({
            changedFields: ['parentTeamId'],
            previous: { parentTeamId: team.id },
        });
        expect(recorded[1].data).toMatchObject({ parentTeamId: parent.id });
        expect(recorded[2].data).toMatchObject({ teamIds: [] });
        expect(recorded[3].data).toMatchObject({ teamIds: [], visibility: 'organization' });
        for (const event of recorded) expectValid(event);
    });

    it('a failed write records nothing (the event shares its transaction)', async () => {
        await newTeam('Platform');
        await expect(newTeam('Platform')).rejects.toThrow(/already exists/);
        expect((await events()).map((event) => event.type)).toEqual(['team.created']);
    });

    it('without the publisher the service records nothing (today’s behaviour)', async () => {
        const team = await plainTeams.create(OWNER, ORG_A, { name: 'Quiet' });
        await plainTeams.update(ORG_A, team.id, { name: 'Quieter' });
        expect(await events()).toEqual([]);
    });
});
