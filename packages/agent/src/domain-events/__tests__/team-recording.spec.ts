import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Mission } from '../../entities/mission.entity';
import { Organization } from '../../entities/organization.entity';
import { Task } from '../../entities/task.entity';
import { Team } from '../../entities/team.entity';
import { TeamMember } from '../../entities/team-member.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkProposal } from '../../entities/work-proposal.entity';
import { TeamResourcesService } from '../../teams/team-resources.service';
import { TeamsService } from '../../teams/teams.service';
import { RecordVisibilityService } from '../../record-visibility/record-visibility.service';
import { Goal } from '../../entities/goal.entity';
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
