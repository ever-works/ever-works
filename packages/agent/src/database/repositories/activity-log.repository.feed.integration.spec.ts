import { DataSource } from 'typeorm';
import { ActivityLog } from '@src/entities/activity-log.entity';
import { Agent, AgentScope, AgentStatus } from '@src/entities/agent.entity';
import { ActivityActionType, ActivityStatus } from '@src/entities/activity-log.types';
import { FeedService, decodeFeedCursor } from '@src/activity-log/feed.service';
import { ActivityLogService } from '@src/activity-log/activity-log.service';
import { buildFeedKindSets, resolveFeedKind } from '@src/activity-log/feed-kind';
import { ENTITIES } from '../_entities-inventory';
import { ActivityLogRepository } from './activity-log.repository';
import { AgentRepository } from './agent.repository';

/**
 * The Live Feed read path executed against a real (in-memory) database — the
 * better-sqlite3 driver CI and the e2e stack run — rather than a mocked query
 * builder. What this pins is exactly what a mock cannot: that the keyset
 * predicate never skips or repeats a row when activity lands at the head
 * between two reads, that the ownership scope and the owner bound every
 * read, that the per-agent filter matches both the new actor column and the
 * `details` reference older rows carry, and that the SQL kind filter agrees
 * with the in-memory classifier row for row.
 */
describe('Live Feed over seeded activity (integration)', () => {
    let dataSource: DataSource;
    let activityLogs: ActivityLogRepository;
    let feed: FeedService;

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const TENANT = '33333333-3333-4333-8333-333333333333';
    const ORG = '44444444-4444-4444-8444-444444444444';
    const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
    const AGENT_IVY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const AGENT_WREN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const PERSONAL = { tenantId: TENANT, organizationId: null };
    const NOW = new Date('2026-09-13T12:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            // The whole inventory: ActivityLog's relations reach most of the
            // schema, so TypeORM's metadata builder refuses a partial list.
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // These specs read activity rows; seeding a valid user / work graph
        // for every fixture would dwarf what is under test.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        activityLogs = new ActivityLogRepository(dataSource.getRepository(ActivityLog));
        const agents = new AgentRepository(dataSource.getRepository(Agent));
        feed = new FeedService(activityLogs, agents);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(ActivityLog).clear();
        await dataSource.getRepository(Agent).clear();
    });

    let sequence = 0;
    function seed(overrides: Partial<ActivityLog> & { minutesAgo?: number }): Promise<ActivityLog> {
        const { minutesAgo = 1, ...rest } = overrides;
        sequence += 1;
        const repository = dataSource.getRepository(ActivityLog);
        return repository.save(
            repository.create({
                userId: USER,
                actionType: ActivityActionType.TASK_CREATED,
                action: 'task_created',
                status: ActivityStatus.COMPLETED,
                summary: `row ${sequence}`,
                tenantId: TENANT,
                organizationId: null,
                createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
                ...rest,
            } as Partial<ActivityLog>),
        );
    }

    async function seedAgent(
        id: string,
        name: string,
        overrides: Partial<Agent> = {},
    ): Promise<void> {
        const agents = dataSource.getRepository(Agent);
        await agents.save(
            agents.create({
                id,
                userId: USER,
                tenantId: TENANT,
                organizationId: null,
                scope: AgentScope.TENANT,
                name,
                slug: name.toLowerCase().replace(/\s+/g, '-'),
                status: AgentStatus.ACTIVE,
                permissions: {},
                ...overrides,
            } as Partial<Agent>),
        );
    }

    /** The real write path, with the agent lookup it captures names through. */
    function activityLogService(): ActivityLogService {
        return new ActivityLogService(
            activityLogs,
            {} as never,
            {} as never,
            undefined,
            new AgentRepository(dataSource.getRepository(Agent)),
        );
    }

    it('pages newest first and never skips or repeats a row when activity lands at the head', async () => {
        // 7 rows, two of them sharing a timestamp so the id tiebreak matters.
        for (let i = 0; i < 6; i++) {
            await seed({ minutesAgo: 10 + i });
        }
        await seed({ minutesAgo: 12 });

        const first = await feed.getPage(USER, PERSONAL, { limit: 3 }, NOW);
        expect(first.items).toHaveLength(3);
        expect(first.hasMore).toBe(true);
        expect(first.nextCursor).not.toBeNull();

        // Two new rows arrive at the head between reads.
        await seed({ minutesAgo: 0 });
        await seed({ minutesAgo: 0 });

        const second = await feed.getPage(
            USER,
            PERSONAL,
            { limit: 3, cursor: first.nextCursor },
            NOW,
        );
        const third = await feed.getPage(
            USER,
            PERSONAL,
            { limit: 3, cursor: second.nextCursor },
            NOW,
        );

        const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
        expect(new Set(ids).size).toBe(7);
        expect(third.hasMore).toBe(false);
        expect(third.nextCursor).toBeNull();

        const times = [...first.items, ...second.items, ...third.items].map(
            (item) => item.createdAt,
        );
        expect([...times].sort().reverse()).toEqual(times);
    });

    it('stops at the 90-day history floor', async () => {
        await seed({ minutesAgo: 60 });
        await seed({ minutesAgo: 91 * 24 * 60 });

        const page = await feed.getPage(USER, PERSONAL, {}, NOW);
        expect(page.items).toHaveLength(1);
        expect(page.hasMore).toBe(false);
        expect(page.historyFloor).toBe(
            new Date(NOW.getTime() - 90 * 24 * 3600 * 1000).toISOString(),
        );
    });

    it('bounds every read by the owner and the active ownership scope', async () => {
        const personal = await seed({ summary: 'personal' });
        const legacy = await seed({ summary: 'legacy', tenantId: null });
        const inOrg = await seed({ summary: 'org', organizationId: ORG });
        await seed({ summary: 'other org', organizationId: OTHER_ORG });
        await seed({ summary: 'other user', userId: OTHER_USER });

        const personalPage = await feed.getPage(USER, PERSONAL, {}, NOW);
        expect(personalPage.items.map((item) => item.id).sort()).toEqual(
            [personal.id, legacy.id].sort(),
        );

        const orgPage = await feed.getPage(
            USER,
            { tenantId: TENANT, organizationId: ORG },
            {},
            NOW,
        );
        expect(orgPage.items.map((item) => item.id)).toEqual([inOrg.id]);
    });

    it('filters by agent on the actor column and on the details reference of older rows', async () => {
        await seedAgent(AGENT_IVY, 'Ivy');
        await seedAgent(AGENT_WREN, 'Wren');
        const stamped = await seed({
            actionType: ActivityActionType.AGENT_RUN_COMPLETED,
            actorKind: 'agent',
            actorAgentId: AGENT_IVY,
            actorLabel: 'Ivy (then)',
        });
        const legacyResource = await seed({
            actionType: ActivityActionType.AGENT_PAUSED,
            details: { resourceType: 'agent', resourceId: AGENT_IVY },
        });
        const legacyAgentId = await seed({
            actionType: ActivityActionType.TASK_MERGED,
            details: { agentId: AGENT_IVY, prNumber: 7 },
        });
        await seed({
            actionType: ActivityActionType.AGENT_PAUSED,
            details: { resourceType: 'agent', resourceId: AGENT_WREN },
        });
        await seed({ actionType: ActivityActionType.SETTINGS_UPDATED });

        const page = await feed.getPage(USER, PERSONAL, { agentIds: [AGENT_IVY] }, NOW);
        expect(page.items.map((item) => item.id).sort()).toEqual(
            [stamped.id, legacyResource.id, legacyAgentId.id].sort(),
        );

        const byId = new Map(page.items.map((item) => [item.id, item]));
        // The name captured when it happened wins over today's name.
        expect(byId.get(stamped.id)?.actor).toMatchObject({ kind: 'agent', label: 'Ivy (then)' });
        expect(byId.get(legacyResource.id)?.actor).toMatchObject({ kind: 'agent', label: 'Ivy' });
        expect(byId.get(legacyResource.id)?.target).toEqual({ type: 'agent', id: AGENT_IVY });
    });

    it('does not let a LIKE wildcard in an agent id widen the match', async () => {
        await seed({ details: { resourceType: 'agent', resourceId: AGENT_IVY } });
        await expect(
            activityLogs.findFeedPage(
                {
                    userId: USER,
                    agentIds: ['%'],
                    since: new Date(0),
                    limit: 10,
                },
                PERSONAL,
            ),
        ).resolves.toMatchObject({ rows: [] });
    });

    it('filters by kind in SQL exactly as the in-memory classifier classifies', async () => {
        const fixtures: Array<[ActivityActionType, ActivityStatus]> = [
            [ActivityActionType.TASK_CREATED, ActivityStatus.COMPLETED],
            [ActivityActionType.INBOX_ITEM_CREATED, ActivityStatus.COMPLETED],
            [ActivityActionType.INBOX_ITEM_CREATED, ActivityStatus.FAILED],
            [ActivityActionType.GIT_MERGED, ActivityStatus.COMPLETED],
            [ActivityActionType.DEPLOYMENT, ActivityStatus.COMPLETED],
            [ActivityActionType.DEPLOYMENT, ActivityStatus.IN_PROGRESS],
            [ActivityActionType.GENERATION, ActivityStatus.CANCELLED],
            [ActivityActionType.PLUGIN_ENABLED, ActivityStatus.COMPLETED],
            [ActivityActionType.TASK_MERGE_REFUSED, ActivityStatus.COMPLETED],
            ['a_future_unmapped_action' as ActivityActionType, ActivityStatus.COMPLETED],
        ];
        for (const [index, [actionType, status]] of fixtures.entries()) {
            await seed({ actionType, status, minutesAgo: index + 1 });
        }

        for (const kind of ['work', 'decision', 'delivery', 'problem', 'system'] as const) {
            const page = await feed.getPage(USER, PERSONAL, { kinds: [kind] }, NOW);
            const expected = fixtures.filter(
                ([actionType, status]) => resolveFeedKind(actionType, status) === kind,
            ).length;
            expect({ kind, count: page.items.length }).toEqual({ kind, count: expected });
            for (const item of page.items) {
                expect(item.kind).toBe(kind);
            }
        }

        const failedOnly = await feed.getPage(
            USER,
            PERSONAL,
            { failedOnly: true, kinds: ['work'] },
            NOW,
        );
        expect(failedOnly.items.map((item) => item.kind)).toEqual([
            'problem',
            'problem',
            'problem',
        ]);

        const combined = await activityLogs.findFeedPage(
            {
                userId: USER,
                kindFilter: { kinds: ['decision', 'delivery'], sets: buildFeedKindSets() },
                since: new Date(0),
                limit: 50,
            },
            PERSONAL,
        );
        expect(combined.rows).toHaveLength(3);
    });

    it('rejects a cursor that does not decode', async () => {
        await expect(
            feed.getPage(USER, PERSONAL, { cursor: 'not a cursor!' }, NOW),
        ).rejects.toMatchObject({
            code: 'invalid-cursor',
        });
    });

    it('mints a cursor whose position is the last row of the page', async () => {
        await seed({ minutesAgo: 3 });
        const last = await seed({ minutesAgo: 5 });
        await seed({ minutesAgo: 7 });

        const page = await feed.getPage(USER, PERSONAL, { limit: 2 }, NOW);
        expect(decodeFeedCursor(page.nextCursor as string)).toEqual({
            createdAt: new Date(last.createdAt).toISOString(),
            id: last.id,
        });
    });

    it('builds the actor roster from scoped agents and counts attributed activity in the window', async () => {
        await seedAgent(AGENT_IVY, 'Ivy');
        await seedAgent(AGENT_WREN, 'Wren');
        await seed({ actorKind: 'agent', actorAgentId: AGENT_WREN, minutesAgo: 5 });
        await seed({ actorKind: 'agent', actorAgentId: AGENT_WREN, minutesAgo: 6 });
        await seed({ actorKind: 'agent', actorAgentId: AGENT_IVY, minutesAgo: 10 });
        // Outside the 1-hour window.
        await seed({ actorKind: 'agent', actorAgentId: AGENT_IVY, minutesAgo: 120 });
        // Another user's activity never counts.
        await seed({ actorKind: 'agent', actorAgentId: AGENT_IVY, userId: OTHER_USER });

        const { actors, windowHours } = await feed.getActors(USER, PERSONAL, 1, NOW);
        expect(windowHours).toBe(1);
        expect(actors.map((actor) => [actor.label, actor.count])).toEqual([
            ['Wren', 2],
            ['Ivy', 1],
        ]);
        expect(actors[0].lastActivityAt).toBe(new Date(NOW.getTime() - 5 * 60_000).toISOString());
    });

    it('lists every scoped agent in the roster, well past one query page', async () => {
        const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        for (let n = 0; n < 205; n++) {
            await seedAgent(agentId(n), `Agent ${n}`);
        }
        // Out of scope or archived: never listed.
        await seedAgent(AGENT_IVY, 'Ivy', { organizationId: OTHER_ORG });
        await seedAgent(AGENT_WREN, 'Wren', { status: AgentStatus.ARCHIVED });

        const { actors } = await feed.getActors(USER, PERSONAL, 1, NOW);

        expect(actors).toHaveLength(205);
        expect(new Set(actors.map((actor) => actor.agentId))).toEqual(
            new Set(Array.from({ length: 205 }, (_, n) => agentId(n))),
        );
    });

    it("keeps the acting agent's name from when it happened after a rename and a deletion", async () => {
        await seedAgent(AGENT_IVY, 'Ivy');
        const written = await activityLogService().log(
            {
                userId: USER,
                actionType: ActivityActionType.AGENT_PAUSED,
                action: 'agent_paused',
                status: ActivityStatus.COMPLETED,
                summary: 'Agent paused',
                details: { resourceType: 'agent', resourceId: AGENT_IVY },
            },
            { createdAt: new Date(NOW.getTime() - 60_000) },
        );
        expect(written).toMatchObject({
            actorKind: 'agent',
            actorAgentId: AGENT_IVY,
            actorLabel: 'Ivy',
        });

        await dataSource.getRepository(Agent).update(AGENT_IVY, { name: 'Ivy Renamed' });
        const afterRename = await feed.getPage(USER, PERSONAL, {}, NOW);
        expect(afterRename.items[0].actor).toMatchObject({ kind: 'agent', label: 'Ivy' });
        expect(afterRename.items[0].narration.params.actor).toBe('Ivy');

        await dataSource.getRepository(Agent).delete(AGENT_IVY);
        const afterDelete = await feed.getPage(USER, PERSONAL, {}, NOW);
        expect(afterDelete.items[0].actor).toMatchObject({ kind: 'agent', label: 'Ivy' });
        expect(afterDelete.items[0].target).toBeNull();
    });

    it('records an agent export as the person acting, still under that agent and opening it', async () => {
        await seedAgent(AGENT_IVY, 'Ivy');
        const exported = await activityLogService().log(
            {
                userId: USER,
                actionType: ActivityActionType.AGENT_EXPORTED,
                action: 'agent_exported',
                status: ActivityStatus.COMPLETED,
                summary: 'Agent exported',
                details: { resourceType: 'agent', resourceId: AGENT_IVY },
            },
            { createdAt: new Date(NOW.getTime() - 60_000) },
        );
        expect(exported.actorKind).toBe('user');
        expect(exported.actorAgentId ?? null).toBeNull();

        const page = await feed.getPage(USER, PERSONAL, { agentIds: [AGENT_IVY] }, NOW);
        expect(page.items.map((item) => item.id)).toEqual([exported.id]);
        expect(page.items[0]).toMatchObject({
            actor: { kind: 'user', label: null },
            target: { type: 'agent', id: AGENT_IVY },
        });

        // An export is not the agent's own activity.
        const { actors } = await feed.getActors(USER, PERSONAL, 1, NOW);
        expect(actors).toEqual([expect.objectContaining({ agentId: AGENT_IVY, count: 0 })]);
    });
});
