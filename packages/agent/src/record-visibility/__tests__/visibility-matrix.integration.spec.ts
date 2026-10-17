import { randomUUID } from 'crypto';
import { DataSource, type ObjectLiteral, type Repository } from 'typeorm';
import type { RecordListView, RecordVisibility, VisibilityAggregate } from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { TaskRepository } from '../../database/repositories/task.repository';
import { Agent, AgentScope } from '../../entities/agent.entity';
import { Goal } from '../../entities/goal.entity';
import { Mission } from '../../entities/mission.entity';
import { MissionWork } from '../../entities/mission-work.entity';
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
import { RecordAccessPolicy } from '../record-access-policy.service';
import type { RecordAccessContext, VisibilityPrincipal } from '../record-access.types';

/**
 * The record visibility matrix (EW-P1-3, `docs/specs/features/record-visibility/spec.md`
 * §3 + §10): owner, participant, team member, work member, org member, Tenant owner,
 * outsider and integration principal × `private` / `team` / `organization`, for all
 * five aggregates, through the REAL `visibleTo(principal)` SQL on better-sqlite3 with
 * the full entity schema.
 *
 * Every record of one aggregate carries the same connections (a Team the team member
 * is on, a Work the work member belongs to, and — for tasks — a user assignee); only
 * `visibility` differs, so each cell isolates exactly one rule.
 */
describe('record visibility matrix (visibleTo, better-sqlite3)', () => {
    let dataSource: DataSource;
    let policy: RecordAccessPolicy;

    const ids = {
        tenantOwner: '',
        owner: '',
        participant: '',
        teamMember: '',
        workMember: '',
        orgMember: '',
        outsider: '',
        tenant: '',
        org: '',
        otherOrg: '',
        team: '',
        work: '',
    };
    /** record ids per aggregate and visibility. */
    const records = new Map<string, string>();
    const key = (aggregate: VisibilityAggregate, visibility: RecordVisibility) =>
        `${aggregate}:${visibility}`;
    const VISIBILITIES: RecordVisibility[] = ['private', 'team', 'organization'];

    const repo = <T extends ObjectLiteral>(entity: new () => T): Repository<T> =>
        dataSource.getRepository(entity);

    async function makeUser(name: string): Promise<string> {
        const users = repo(User);
        const user = await users.save(
            users.create({
                username: `${name}-${randomUUID().slice(0, 8)}`,
                email: `${name}-${randomUUID().slice(0, 8)}@example.com`,
                password: 'x',
            } as Partial<User>),
        );
        return user.id;
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();

        ids.tenantOwner = await makeUser('tenant-owner');
        ids.owner = await makeUser('owner');
        ids.participant = await makeUser('participant');
        ids.teamMember = await makeUser('team-member');
        ids.workMember = await makeUser('work-member');
        ids.orgMember = await makeUser('org-member');
        ids.outsider = await makeUser('outsider');

        const tenant = await repo(Tenant).save(
            repo(Tenant).create({
                ownerUserId: ids.tenantOwner,
                slug: 'acme',
                displayName: 'Acme',
            } as Partial<Tenant>),
        );
        ids.tenant = tenant.id;
        const org = await repo(Organization).save(
            repo(Organization).create({
                tenantId: tenant.id,
                slug: 'acme-org',
                displayName: 'Acme Org',
            } as Partial<Organization>),
        );
        ids.org = org.id;
        const otherOrg = await repo(Organization).save(
            repo(Organization).create({
                tenantId: tenant.id,
                slug: 'acme-other',
                displayName: 'Acme Other',
            } as Partial<Organization>),
        );
        ids.otherOrg = otherOrg.id;

        // Roster: everyone in the tenant is on the roster of the org EXCEPT the
        // outsider (and the Tenant owner, a member by construction with no row).
        for (const userId of [
            ids.owner,
            ids.participant,
            ids.teamMember,
            ids.workMember,
            ids.orgMember,
        ]) {
            await repo(OrganizationMember).save(
                repo(OrganizationMember).create({
                    organizationId: org.id,
                    tenantId: tenant.id,
                    userId,
                    role: 'member',
                    invitedById: null,
                    invitationId: null,
                    joinedAt: new Date(),
                }),
            );
        }

        const team = await repo(Team).save(
            repo(Team).create({
                userId: ids.owner,
                name: 'Core',
                slug: 'core',
                tenantId: tenant.id,
                organizationId: org.id,
            } as Partial<Team>),
        );
        ids.team = team.id;
        await repo(TeamMember).save(
            repo(TeamMember).create({
                teamId: team.id,
                memberType: 'user',
                memberId: ids.teamMember,
                tenantId: tenant.id,
                organizationId: org.id,
            } as Partial<TeamMember>),
        );

        const work = await repo(Work).save(
            repo(Work).create({
                name: 'Site',
                slug: 'site',
                userId: ids.owner,
                description: 'A work',
                tenantId: tenant.id,
                organizationId: org.id,
            } as Partial<Work>),
        );
        ids.work = work.id;
        await repo(WorkMember).save(
            repo(WorkMember).create({
                workId: work.id,
                userId: ids.workMember,
                tenantId: tenant.id,
                organizationId: org.id,
            } as Partial<WorkMember>),
        );

        const scope = { tenantId: tenant.id, organizationId: org.id };
        let n = 0;
        for (const visibility of VISIBILITIES) {
            n += 1;
            const flags = { visibility, visibilityExplicit: true };

            const task = await repo(Task).save(
                repo(Task).create({
                    userId: ids.owner,
                    slug: `T-${n}`,
                    title: `Task ${visibility}`,
                    createdByType: 'user',
                    createdById: ids.owner,
                    teamId: team.id,
                    workId: work.id,
                    ...scope,
                    ...flags,
                } as Partial<Task>),
            );
            records.set(key('task', visibility), task.id);
            await repo(TaskAssignee).save(
                repo(TaskAssignee).create({
                    taskId: task.id,
                    assigneeType: 'user',
                    assigneeId: ids.participant,
                    ...scope,
                } as Partial<TaskAssignee>),
            );

            const goal = await repo(Goal).save(
                repo(Goal).create({
                    userId: ids.owner,
                    title: `Goal ${visibility}`,
                    window: 'total',
                    ...scope,
                    ...flags,
                } as Partial<Goal>),
            );
            records.set(key('goal', visibility), goal.id);

            const mission = await repo(Mission).save(
                repo(Mission).create({
                    userId: ids.owner,
                    title: `Mission ${visibility}`,
                    description: 'd',
                    type: 'one-shot',
                    ...scope,
                    ...flags,
                } as Partial<Mission>),
            );
            records.set(key('mission', visibility), mission.id);
            await repo(MissionWork).save(
                repo(MissionWork).create({
                    userId: ids.owner,
                    missionId: mission.id,
                    workId: work.id,
                    relation: 'improves',
                    ...scope,
                } as Partial<MissionWork>),
            );

            const idea = await repo(WorkProposal).save(
                repo(WorkProposal).create({
                    userId: ids.owner,
                    title: `Idea ${visibility}`,
                    description: 'd',
                    slugSuggestion: `idea-${n}`,
                    suggestedCategories: [],
                    suggestedFields: [],
                    recommendedPlugins: [],
                    reasoning: 'r',
                    ...scope,
                    ...flags,
                } as Partial<WorkProposal>),
            );
            records.set(key('idea', visibility), idea.id);

            const agent = await repo(Agent).save(
                repo(Agent).create({
                    userId: ids.owner,
                    scope: AgentScope.WORK,
                    workId: work.id,
                    name: `Agent ${visibility}`,
                    slug: `agent-${n}`,
                    permissions: {},
                    ...scope,
                    ...flags,
                } as Partial<Agent>),
            );
            records.set(key('agent', visibility), agent.id);

            // Team connections: goals / missions / ideas through team_resources,
            // agents through team_members (memberType agent).
            for (const [resourceType, resourceId] of [
                ['goal', goal.id],
                ['mission', mission.id],
                ['idea', idea.id],
            ] as const) {
                await repo(TeamResource).save(
                    repo(TeamResource).create({
                        teamId: team.id,
                        resourceType,
                        resourceId,
                        ...scope,
                        createdAt: new Date(),
                    }),
                );
            }
            await repo(TeamMember).save(
                repo(TeamMember).create({
                    teamId: team.id,
                    memberType: 'agent',
                    memberId: agent.id,
                    ...scope,
                } as Partial<TeamMember>),
            );
        }

        policy = new RecordAccessPolicy(
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
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const TABLES: Record<VisibilityAggregate, new () => ObjectLiteral> = {
        task: Task,
        goal: Goal,
        mission: Mission,
        idea: WorkProposal,
        agent: Agent,
    };

    async function visibleVisibilities(
        aggregate: VisibilityAggregate,
        context: RecordAccessContext,
        view: RecordListView = 'organization',
    ): Promise<RecordVisibility[]> {
        const alias = 'rec';
        const qb = repo(TABLES[aggregate]).createQueryBuilder(alias);
        policy.applyVisibleTo(qb, alias, aggregate, context, view);
        qb.andWhere(`${alias}.organizationId = :orgFilter`, { orgFilter: ids.org });
        const rows = (await qb.getMany()) as Array<{ id: string }>;
        return VISIBILITIES.filter((visibility) =>
            rows.some((row) => row.id === records.get(key(aggregate, visibility))),
        );
    }

    const userContext = (userId: string) =>
        policy.contextFor(
            { kind: 'user', userId },
            { tenantId: ids.tenant, organizationId: ids.org },
        );

    const ALL: RecordVisibility[] = ['private', 'team', 'organization'];
    const CONNECTED: RecordVisibility[] = ['team', 'organization'];
    const ORG_ONLY: RecordVisibility[] = ['organization'];

    type Who =
        | 'owner'
        | 'participant'
        | 'teamMember'
        | 'workMember'
        | 'orgMember'
        | 'tenantOwner'
        | 'outsider';

    const EXPECTED: Record<VisibilityAggregate, Record<Who, RecordVisibility[]>> = {
        task: {
            owner: ALL,
            participant: ALL,
            teamMember: CONNECTED,
            workMember: CONNECTED,
            orgMember: ORG_ONLY,
            tenantOwner: ORG_ONLY,
            outsider: [],
        },
        // Goals: no Work column, no participants — the team member reaches them through
        // team_resources (type goal); a work member is just an org member.
        goal: {
            owner: ALL,
            participant: ORG_ONLY,
            teamMember: CONNECTED,
            workMember: ORG_ONLY,
            orgMember: ORG_ONLY,
            tenantOwner: ORG_ONLY,
            outsider: [],
        },
        // Missions: Teams through team_resources, Works through mission_works.
        mission: {
            owner: ALL,
            participant: ORG_ONLY,
            teamMember: CONNECTED,
            workMember: CONNECTED,
            orgMember: ORG_ONLY,
            tenantOwner: ORG_ONLY,
            outsider: [],
        },
        idea: {
            owner: ALL,
            participant: ORG_ONLY,
            teamMember: CONNECTED,
            workMember: ORG_ONLY,
            orgMember: ORG_ONLY,
            tenantOwner: ORG_ONLY,
            outsider: [],
        },
        // Agents: Teams through team_members (memberType agent), Works through workId.
        agent: {
            owner: ALL,
            participant: ORG_ONLY,
            teamMember: CONNECTED,
            workMember: CONNECTED,
            orgMember: ORG_ONLY,
            tenantOwner: ORG_ONLY,
            outsider: [],
        },
    };

    const AGGREGATES: VisibilityAggregate[] = ['task', 'goal', 'mission', 'idea', 'agent'];
    const WHO: Who[] = [
        'owner',
        'participant',
        'teamMember',
        'workMember',
        'orgMember',
        'tenantOwner',
        'outsider',
    ];

    describe.each(AGGREGATES)('%s', (aggregate) => {
        it.each(WHO)('%s reads exactly the expected visibilities', async (who) => {
            const context = await userContext(ids[who]);
            expect(await visibleVisibilities(aggregate, context)).toEqual(EXPECTED[aggregate][who]);
        });

        it('integration principal pinned to the org reads team + organization, never private', async () => {
            const context = await policy.contextFor(
                { kind: 'integration', organizationIds: [ids.org] } as VisibilityPrincipal,
                { tenantId: ids.tenant, organizationId: ids.org },
            );
            expect(await visibleVisibilities(aggregate, context)).toEqual(CONNECTED);
        });

        it('integration principal pinned to another org reads nothing here', async () => {
            const context = await policy.contextFor(
                { kind: 'integration', organizationIds: [ids.otherOrg] } as VisibilityPrincipal,
                null,
            );
            expect(await visibleVisibilities(aggregate, context)).toEqual([]);
        });

        it('mine = owner only (today’s list), shared never includes own rows', async () => {
            const ownerContext = await userContext(ids.owner);
            expect(await visibleVisibilities(aggregate, ownerContext, 'mine')).toEqual(ALL);
            expect(await visibleVisibilities(aggregate, ownerContext, 'shared')).toEqual([]);
            const teamContext = await userContext(ids.teamMember);
            expect(await visibleVisibilities(aggregate, teamContext, 'mine')).toEqual([]);
            expect(await visibleVisibilities(aggregate, teamContext, 'shared')).toEqual(CONNECTED);
            const orgContext = await userContext(ids.orgMember);
            // Organization-wide rows the org member merely CAN see are not "shared with
            // me" — that tab is participation and Team / Work connections only.
            expect(await visibleVisibilities(aggregate, orgContext, 'shared')).toEqual([]);
        });

        it('personal scope stays owner-only', async () => {
            const context = await policy.contextFor(
                { kind: 'user', userId: ids.teamMember },
                { tenantId: ids.tenant, organizationId: null },
            );
            expect(await visibleVisibilities(aggregate, context)).toEqual([]);
        });
    });

    it('a task participant sees a private task in Shared with me', async () => {
        const context = await userContext(ids.participant);
        expect(await visibleVisibilities('task', context, 'shared')).toEqual(ALL);
    });

    it('roster: members and the Tenant owner are members, the outsider is not', async () => {
        expect(await policy.isOrganizationMember(ids.org, ids.orgMember)).toBe(true);
        expect(await policy.isOrganizationMember(ids.org, ids.tenantOwner)).toBe(true);
        expect(await policy.isOrganizationMember(ids.org, ids.outsider)).toBe(false);
        expect(await policy.isOrganizationMember(ids.otherOrg, ids.orgMember)).toBe(false);
    });

    it('isTaskParticipant honours the requested kinds', async () => {
        const taskId = records.get(key('task', 'private'))!;
        expect(await policy.isTaskParticipant(taskId, ids.participant)).toBe(true);
        expect(await policy.isTaskParticipant(taskId, ids.participant, ['watcher'])).toBe(false);
        expect(await policy.isTaskParticipant(taskId, ids.teamMember)).toBe(false);
    });

    describe('TaskRepository through the policy (replaced `userId = caller` filters)', () => {
        it('findByUserIdFiltered (the `mine` list) is unchanged: owner rows only', async () => {
            const tasks = new TaskRepository(repo(Task));
            const scope = { tenantId: ids.tenant, organizationId: ids.org };
            const mine = await tasks.findByUserIdFiltered(ids.teamMember, {}, scope);
            expect(mine.total).toBe(0);
            const owner = await tasks.findByUserIdFiltered(ids.owner, {}, scope);
            expect(owner.total).toBe(3);
        });

        it('findVisibleFiltered keeps every filter and the count', async () => {
            const tasks = new TaskRepository(repo(Task));
            const scope = { tenantId: ids.tenant, organizationId: ids.org };
            const context = await userContext(ids.teamMember);
            const all = await tasks.findVisibleFiltered(context, 'organization', {}, scope);
            expect(all.total).toBe(2);
            const searched = await tasks.findVisibleFiltered(
                context,
                'organization',
                { search: 'organization' },
                scope,
            );
            expect(searched.rows.map((row) => row.title)).toEqual(['Task organization']);
        });

        it('findVisibleById admits a reader and 404s (null) everyone else', async () => {
            const tasks = new TaskRepository(repo(Task));
            const scope = { tenantId: ids.tenant, organizationId: ids.org };
            const privateId = records.get(key('task', 'private'))!;
            const orgId = records.get(key('task', 'organization'))!;
            const orgMember = await userContext(ids.orgMember);
            expect(await tasks.findVisibleById(privateId, orgMember, scope)).toBeNull();
            expect((await tasks.findVisibleById(orgId, orgMember, scope))?.id).toBe(orgId);
            const outsider = await userContext(ids.outsider);
            expect(await tasks.findVisibleById(orgId, outsider, scope)).toBeNull();
        });
    });
});
