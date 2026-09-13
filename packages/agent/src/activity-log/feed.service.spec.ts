import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
    FeedInvalidCursorError,
    FeedService,
    FeedTooManyAgentsError,
    decodeFeedCursor,
    encodeFeedCursor,
} from './feed.service';

const USER = '11111111-1111-4111-8111-111111111111';
const IVY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WREN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROW_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROW_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SCOPE = { tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', organizationId: null };
const NOW = new Date('2026-09-13T12:00:00.000Z');

function build(
    overrides: { rows?: unknown[]; hasMore?: boolean; sortKeys?: Map<string, string> } = {},
) {
    const rows = (overrides.rows ?? []) as Array<{ id: string; createdAt: Date }>;
    const activityLogs = {
        findFeedPage: jest.fn().mockResolvedValue({
            rows,
            hasMore: overrides.hasMore ?? false,
            sortKeys:
                overrides.sortKeys ??
                new Map(rows.map((row) => [row.id, new Date(row.createdAt).toISOString()])),
        }),
        aggregateFeedActors: jest.fn().mockResolvedValue([]),
    };
    const agents = {
        findManyByIdsForUser: jest.fn().mockResolvedValue([]),
        findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
        findRosterPage: jest.fn().mockResolvedValue([]),
    };
    const service = new FeedService(activityLogs as never, agents as never);
    return { service, activityLogs, agents };
}

const activity = (overrides: Record<string, unknown> = {}) => ({
    id: ROW_1,
    userId: USER,
    actionType: ActivityActionType.TASK_CREATED,
    status: ActivityStatus.COMPLETED,
    summary: 'Task created',
    details: { title: 'Weekly sweep' },
    createdAt: new Date('2026-09-13T11:00:00.000Z'),
    ...overrides,
});

describe('FeedService', () => {
    describe('cursor encoding', () => {
        it('round-trips a position, including a microsecond-precise timestamp', () => {
            const position = { createdAt: '2026-09-13T11:00:00.123456', id: ROW_1 };
            expect(decodeFeedCursor(encodeFeedCursor(position))).toEqual(position);
            const iso = { createdAt: '2026-09-13T11:00:00.123Z', id: ROW_2 };
            expect(decodeFeedCursor(encodeFeedCursor(iso))).toEqual(iso);
        });

        it.each([
            ['empty', ''],
            ['not base64url', 'not a cursor!'],
            ['not JSON', Buffer.from('nope').toString('base64url')],
            ['an array', Buffer.from('[1,2]').toString('base64url')],
            [
                'a bad timestamp',
                Buffer.from(JSON.stringify({ t: 'yesterday', i: ROW_1 })).toString('base64url'),
            ],
            [
                'an impossible date',
                Buffer.from(JSON.stringify({ t: '2026-13-45T99:99:99Z', i: ROW_1 })).toString(
                    'base64url',
                ),
            ],
            [
                'a non-uuid id',
                Buffer.from(JSON.stringify({ t: '2026-09-13T11:00:00Z', i: '1 OR 1=1' })).toString(
                    'base64url',
                ),
            ],
            ['too long', 'a'.repeat(300)],
        ])('rejects a cursor that is %s', (_label, cursor) => {
            expect(() => decodeFeedCursor(cursor)).toThrow(FeedInvalidCursorError);
        });
    });

    describe('getPage', () => {
        it('reads with the caller-supplied owner and scope, the 90-day floor and the default page size', async () => {
            const { service, activityLogs } = build();
            const page = await service.getPage(USER, SCOPE, {}, NOW);

            expect(activityLogs.findFeedPage).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: USER,
                    limit: 30,
                    since: new Date('2026-06-15T12:00:00.000Z'),
                    agentIds: undefined,
                    kindFilter: undefined,
                    cursor: undefined,
                }),
                SCOPE,
            );
            expect(page).toEqual({
                items: [],
                nextCursor: null,
                hasMore: false,
                historyFloor: '2026-06-15T12:00:00.000Z',
            });
        });

        it('clamps the page size to at most 50 and at least 1', async () => {
            const { service, activityLogs } = build();
            await service.getPage(USER, SCOPE, { limit: 5000 }, NOW);
            expect(activityLogs.findFeedPage.mock.calls[0][0].limit).toBe(50);
            await service.getPage(USER, SCOPE, { limit: 0 }, NOW);
            expect(activityLogs.findFeedPage.mock.calls[1][0].limit).toBe(1);
        });

        it('refuses more than 20 agents instead of truncating', async () => {
            const { service, activityLogs } = build();
            const ids = Array.from(
                { length: 21 },
                (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
            );
            await expect(
                service.getPage(USER, SCOPE, { agentIds: ids }, NOW),
            ).rejects.toBeInstanceOf(FeedTooManyAgentsError);
            expect(activityLogs.findFeedPage).not.toHaveBeenCalled();
        });

        it('counts duplicate agent ids once toward the cap', async () => {
            const { service, activityLogs } = build();
            await service.getPage(
                USER,
                SCOPE,
                { agentIds: Array.from({ length: 30 }, () => IVY) },
                NOW,
            );
            expect(activityLogs.findFeedPage.mock.calls[0][0].agentIds).toEqual([IVY]);
        });

        it('returns an empty page without querying when every agent id is malformed', async () => {
            const { service, activityLogs } = build();
            const page = await service.getPage(USER, SCOPE, { agentIds: ['not-a-uuid'] }, NOW);
            expect(page.items).toEqual([]);
            expect(activityLogs.findFeedPage).not.toHaveBeenCalled();
        });

        it('rejects a malformed cursor before touching the database', async () => {
            const { service, activityLogs } = build();
            await expect(
                service.getPage(USER, SCOPE, { cursor: '%%%' }, NOW),
            ).rejects.toMatchObject({
                code: 'invalid-cursor',
            });
            expect(activityLogs.findFeedPage).not.toHaveBeenCalled();
        });

        it('turns "only what failed" into the problem kind filter', async () => {
            const { service, activityLogs } = build();
            await service.getPage(USER, SCOPE, { kinds: ['work'], failedOnly: true }, NOW);
            const { kindFilter } = activityLogs.findFeedPage.mock.calls[0][0];
            expect(kindFilter.kinds).toEqual(['problem']);
            expect(kindFilter.sets.problemStatuses).toEqual(['failed', 'cancelled']);
        });

        it('mints the next cursor from the exact sort key of the last row', async () => {
            const rows = [activity({ id: ROW_1 }), activity({ id: ROW_2 })];
            const { service } = build({
                rows,
                hasMore: true,
                sortKeys: new Map([
                    [ROW_1, '2026-09-13T11:00:00.654321'],
                    [ROW_2, '2026-09-13T10:59:59.123456'],
                ]),
            });
            const page = await service.getPage(USER, SCOPE, {}, NOW);
            expect(page.hasMore).toBe(true);
            expect(decodeFeedCursor(page.nextCursor as string)).toEqual({
                createdAt: '2026-09-13T10:59:59.123456',
                id: ROW_2,
            });
        });

        it('narrates, classifies and points each entry, with one batched agent lookup per page', async () => {
            const rows = [
                activity({
                    id: ROW_1,
                    actionType: ActivityActionType.AGENT_HEARTBEAT_FAILED,
                    status: ActivityStatus.FAILED,
                    details: { resourceType: 'agent', resourceId: IVY, runId: RUN },
                }),
                activity({
                    id: ROW_2,
                    actionType: ActivityActionType.AGENT_PAUSED,
                    details: { resourceType: 'agent', resourceId: WREN },
                }),
            ];
            const { service, agents } = build({ rows });
            agents.findManyByIdsForUser.mockResolvedValue([
                { id: IVY, name: 'Ivy', avatarMode: 'initials' },
            ]);

            const page = await service.getPage(USER, SCOPE, {}, NOW);

            expect(agents.findManyByIdsForUser).toHaveBeenCalledTimes(1);
            expect(agents.findManyByIdsForUser).toHaveBeenCalledWith(USER, [IVY, WREN]);
            expect(page.items[0]).toMatchObject({
                id: ROW_1,
                kind: 'problem',
                status: 'failed',
                actor: { kind: 'agent', agentId: IVY, label: 'Ivy', avatarMode: 'initials' },
                narration: { key: 'agentHeartbeatFailed', params: { actor: 'Ivy' } },
                target: { type: 'run', id: RUN },
            });
            // Wren has since been deleted: no name to show, nothing to open.
            expect(page.items[1]).toMatchObject({
                id: ROW_2,
                kind: 'work',
                actor: { kind: 'agent', agentId: WREN, label: null },
                target: null,
            });
        });

        it('attributes an agent export to the person who ran it, still opening the agent', async () => {
            const rows = [
                activity({
                    id: ROW_1,
                    actionType: ActivityActionType.AGENT_EXPORTED,
                    details: { resourceType: 'agent', resourceId: IVY },
                }),
                activity({
                    id: ROW_2,
                    actionType: ActivityActionType.AGENT_IMPORTED,
                    actorKind: 'user',
                    details: { resourceType: 'agent', resourceId: WREN },
                }),
            ];
            const { service, agents } = build({ rows });
            agents.findManyByIdsForUser.mockResolvedValue([
                { id: IVY, name: 'Ivy', avatarMode: 'initials' },
            ]);

            const page = await service.getPage(USER, SCOPE, {}, NOW);

            // The subject agents are looked up (for the link), in one batch.
            expect(agents.findManyByIdsForUser).toHaveBeenCalledTimes(1);
            expect(agents.findManyByIdsForUser).toHaveBeenCalledWith(USER, [IVY, WREN]);
            expect(page.items[0]).toMatchObject({
                actor: { kind: 'user', label: null },
                narration: { key: 'fallback', params: { actor: '' } },
                target: { type: 'agent', id: IVY },
            });
            // Wren is gone: still the person's action, with nothing to open.
            expect(page.items[1]).toMatchObject({
                actor: { kind: 'user', label: null },
                target: null,
            });
        });

        it('skips the agent lookup when no row refers to an agent', async () => {
            const { service, agents } = build({ rows: [activity()] });
            const page = await service.getPage(USER, SCOPE, {}, NOW);
            expect(agents.findManyByIdsForUser).not.toHaveBeenCalled();
            expect(page.items[0].actor).toEqual({ kind: 'user', label: null });
        });
    });

    describe('getActors', () => {
        it('lists scoped agents busiest first, including agents with no activity', async () => {
            const { service, activityLogs, agents } = build();
            agents.findRosterPage.mockResolvedValue([
                { id: IVY, name: 'Ivy', status: 'active', avatarMode: 'initials' },
                { id: WREN, name: 'Wren', status: 'paused', avatarMode: 'icon' },
            ]);
            activityLogs.aggregateFeedActors.mockResolvedValue([
                { agentId: WREN, count: 4, lastActivityAt: '2026-09-13T11:00:00.000Z' },
            ]);

            const result = await service.getActors(USER, SCOPE, undefined, NOW);

            expect(agents.findRosterPage).toHaveBeenCalledTimes(1);
            expect(agents.findRosterPage).toHaveBeenCalledWith(USER, SCOPE, {
                afterId: null,
                limit: 200,
            });
            // Every acting agent in the window is counted — no cap.
            expect(activityLogs.aggregateFeedActors).toHaveBeenCalledWith(
                USER,
                SCOPE,
                new Date('2026-09-06T12:00:00.000Z'),
            );
            expect(result).toEqual({
                windowHours: 168,
                actors: [
                    {
                        agentId: WREN,
                        label: 'Wren',
                        status: 'paused',
                        avatarMode: 'icon',
                        count: 4,
                        lastActivityAt: '2026-09-13T11:00:00.000Z',
                    },
                    {
                        agentId: IVY,
                        label: 'Ivy',
                        status: 'active',
                        avatarMode: 'initials',
                        count: 0,
                        lastActivityAt: null,
                    },
                ],
            });
        });

        it('adds an agent with activity that the catalog no longer lists, and leaves deleted ones out', async () => {
            const { service, activityLogs, agents } = build();
            activityLogs.aggregateFeedActors.mockResolvedValue([
                { agentId: IVY, count: 2, lastActivityAt: null },
                { agentId: WREN, count: 1, lastActivityAt: null },
            ]);
            agents.findManyByIdsForUser.mockResolvedValue([
                { id: IVY, name: 'Ivy', status: 'archived', avatarMode: null },
            ]);

            const result = await service.getActors(USER, SCOPE, 24, NOW);

            expect(agents.findManyByIdsForUser).toHaveBeenCalledWith(USER, [IVY, WREN]);
            expect(result.actors.map((actor) => actor.agentId)).toEqual([IVY]);
        });

        it('lists every scoped agent, however many, by walking the catalog page by page', async () => {
            const { service, activityLogs, agents } = build();
            const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
            const catalog = Array.from({ length: 450 }, (_, n) => ({
                id: agentId(n),
                name: `Agent ${n}`,
                status: n === 449 ? 'paused' : 'active',
                avatarMode: null,
            }));
            agents.findRosterPage.mockImplementation(
                async (
                    _user: string,
                    _scope: unknown,
                    options: { afterId: string | null; limit: number },
                ) => {
                    const start = options.afterId
                        ? catalog.findIndex((agent) => agent.id === options.afterId) + 1
                        : 0;
                    return catalog.slice(start, start + options.limit);
                },
            );
            // The busiest agent is the oldest, least recently touched one.
            activityLogs.aggregateFeedActors.mockResolvedValue([
                { agentId: agentId(449), count: 9, lastActivityAt: '2026-09-13T11:00:00.000Z' },
            ]);

            const result = await service.getActors(USER, SCOPE, undefined, NOW);

            expect(result.actors).toHaveLength(450);
            expect(new Set(result.actors.map((actor) => actor.agentId)).size).toBe(450);
            expect(result.actors[0]).toMatchObject({ agentId: agentId(449), count: 9 });
            expect(agents.findRosterPage.mock.calls.map((call) => call[2])).toEqual([
                { afterId: null, limit: 200 },
                { afterId: agentId(199), limit: 200 },
                { afterId: agentId(399), limit: 200 },
            ]);
            expect(agents.findManyByIdsForUser).not.toHaveBeenCalled();
        });

        it('stops walking when a page does not advance', async () => {
            const { service, agents } = build();
            const stuck = Array.from({ length: 200 }, () => ({
                id: IVY,
                name: 'Ivy',
                status: 'active',
                avatarMode: null,
            }));
            agents.findRosterPage.mockResolvedValue(stuck);

            const result = await service.getActors(USER, SCOPE, undefined, NOW);

            expect(agents.findRosterPage).toHaveBeenCalledTimes(2);
            expect(result.actors.map((actor) => actor.agentId)).toEqual([IVY]);
        });

        it('clamps the window to 1..720 hours', async () => {
            const { service } = build();
            expect((await service.getActors(USER, SCOPE, 99999, NOW)).windowHours).toBe(720);
            expect((await service.getActors(USER, SCOPE, -5, NOW)).windowHours).toBe(1);
        });
    });
});
