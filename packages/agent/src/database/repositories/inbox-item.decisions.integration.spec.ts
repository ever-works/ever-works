import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Task, TaskStatus } from '../../entities/task.entity';
import { AgentEscalation } from '../../entities/agent-escalation.entity';
import { AgentActionProposal } from '../../entities/agent-action-proposal.entity';
import { InboxItem } from '../../entities/inbox-item.entity';
import { InboxItemRepository, type InboxDecisionRow } from './inbox-item.repository';

/**
 * My Decisions — the decision view of the Inbox, against a real SQL engine.
 *
 * The ranking, the owner-scoped joins and the header count are SQL, so a
 * mocked query builder would only prove the calls were made. This runs the
 * real statements on better-sqlite3 (what CI and the e2e stack run) with
 * the full entity inventory, and pins:
 *
 *   - only questions, approvals and escalations are decisions;
 *   - blocking first, then confidence (unscored at 0.5), then oldest first;
 *   - the Task / Mission / Agent / kind / search filters;
 *   - a link to ANOTHER owner's run or Task reads as absent, never leaks;
 *   - the header count uses the same "blocking" predicate as the ranking.
 */
describe('InboxItemRepository — decision view (integration)', () => {
    let dataSource: DataSource;
    let items: Repository<InboxItem>;
    let repository: InboxItemRepository;

    let userId: string;
    let otherUserId: string;
    let agentId: string;
    let blockedTaskId: string;
    let missionTaskId: string;
    let foreignTaskId: string;
    let parkedRunId: string;
    let foreignRunId: string;

    const MISSION_ID = '44444444-4444-4444-8444-444444444444';

    let clock = Date.parse('2026-08-01T00:00:00.000Z');
    const nextDate = () => new Date((clock += 60_000));

    async function seedItem(overrides: Partial<InboxItem>): Promise<InboxItem> {
        return items.save(
            items.create({
                userId,
                kind: 'question',
                title: 'A question',
                body: 'A question',
                sourceType: 'agent-run',
                status: 'open',
                unread: true,
                createdAt: nextDate(),
                ...overrides,
            } as Partial<InboxItem>),
        );
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();

        items = dataSource.getRepository(InboxItem);
        repository = new InboxItemRepository(items);

        const users = dataSource.getRepository(User);
        userId = (
            await users.save(
                users.create({
                    username: 'owner',
                    email: 'owner@example.com',
                    password: 'x',
                } as Partial<User>),
            )
        ).id;
        otherUserId = (
            await users.save(
                users.create({
                    username: 'stranger',
                    email: 'stranger@example.com',
                    password: 'x',
                } as Partial<User>),
            )
        ).id;

        const agents = dataSource.getRepository(Agent);
        agentId = (
            await agents.save(
                agents.create({
                    userId,
                    scope: AgentScope.TENANT,
                    name: 'Researcher',
                    slug: 'researcher',
                    status: AgentStatus.ACTIVE,
                    permissions: {},
                } as Partial<Agent>),
            )
        ).id;

        const tasks = dataSource.getRepository(Task);
        const makeTask = (owner: string, slug: string, overrides: Partial<Task>) =>
            tasks.save(
                tasks.create({
                    userId: owner,
                    slug,
                    title: `Task ${slug}`,
                    status: TaskStatus.TODO,
                    createdByType: 'user',
                    createdById: owner,
                    ...overrides,
                } as Partial<Task>),
            );
        blockedTaskId = (await makeTask(userId, 'T-1', { status: TaskStatus.BLOCKED })).id;
        missionTaskId = (await makeTask(userId, 'T-2', { missionId: MISSION_ID })).id;
        foreignTaskId = (
            await makeTask(otherUserId, 'T-9', {
                status: TaskStatus.BLOCKED,
                title: 'Someone else',
            })
        ).id;

        const runs = dataSource.getRepository(AgentRun);
        const makeRun = (owner: string, overrides: Partial<AgentRun>) =>
            runs.save(
                runs.create({
                    userId: owner,
                    agentId,
                    triggerKind: 'task',
                    status: 'completed',
                    gateAttempts: 0,
                    persistent: false,
                    awaitingInput: false,
                    interruptRequested: false,
                    ...overrides,
                } as Partial<AgentRun>),
            );
        parkedRunId = (await makeRun(userId, { awaitingInput: true, taskId: missionTaskId })).id;
        foreignRunId = (await makeRun(otherUserId, { awaitingInput: true, taskId: foreignTaskId }))
            .id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await items.clear();
        await dataSource.getRepository(AgentEscalation).clear();
        await dataSource.getRepository(AgentActionProposal).clear();
    });

    it('lists only decision kinds, open by default', async () => {
        await seedItem({ kind: 'question', title: 'q' });
        await seedItem({ kind: 'notice', title: 'n' });
        await seedItem({ kind: 'approval', title: 'a', sourceType: 'proposal' });
        await seedItem({ kind: 'escalation', title: 'answered', status: 'answered' });

        const { rows, total } = await repository.listDecisionsForUser(userId);

        expect(total).toBe(2);
        expect(rows.map((row) => row.item.title).sort()).toEqual(['a', 'q']);
    });

    it('ranks blocking first, then confidence with unscored at 0.5, then oldest first', async () => {
        const escalations = dataSource.getRepository(AgentEscalation);
        const makeEscalation = (confidence: number | null) =>
            escalations.save(
                escalations.create({
                    userId,
                    reasonCode: 'gate-exhausted',
                    status: 'open',
                    summary: 's',
                    decisionNeeded: 'd',
                    confidence,
                    confidenceSource: confidence === null ? null : 'heuristic',
                } as Partial<AgentEscalation>),
            );
        const weak = await makeEscalation(0.4);
        const strong = await makeEscalation(0.6);

        await seedItem({ title: 'old-unscored' });
        await seedItem({ kind: 'escalation', title: 'weak', escalationId: weak.id });
        await seedItem({ kind: 'escalation', title: 'strong', escalationId: strong.id });
        await seedItem({ title: 'new-unscored' });
        await seedItem({ title: 'parked', agentRunId: parkedRunId });
        await seedItem({ kind: 'escalation', title: 'task-blocked', taskId: blockedTaskId });

        const { rows } = await repository.listDecisionsForUser(userId);

        expect(rows.map((row) => row.item.title)).toEqual([
            // Both blocking rows first, oldest of them first.
            'parked',
            'task-blocked',
            // Then 0.6 > unscored (0.5, oldest first) > 0.4.
            'strong',
            'old-unscored',
            'new-unscored',
            'weak',
        ]);
        const parked = rows.find((row) => row.item.title === 'parked')!;
        expect(parked.runParked).toBe(true);
        expect(parked.taskId).toBe(missionTaskId);
        expect(parked.missionId).toBe(MISSION_ID);
        const strongRow = rows.find((row) => row.item.title === 'strong')!;
        expect(strongRow.confidence).toBeCloseTo(0.6);
        expect(strongRow.reasonCode).toBe('gate-exhausted');
    });

    it('reads another owner’s linked run or Task as absent', async () => {
        await seedItem({ title: 'stale-links', agentRunId: foreignRunId, taskId: foreignTaskId });

        const { rows } = await repository.listDecisionsForUser(userId);
        const counts = await repository.countDecisionsForUser(userId);

        expect(rows).toHaveLength(1);
        expect(rows[0].runParked).toBe(false);
        expect(rows[0].taskTitle).toBeNull();
        expect(rows[0].taskStatus).toBeNull();
        expect(counts.blocking).toBe(0);
    });

    it('never returns another owner’s items', async () => {
        await seedItem({ userId: otherUserId, title: 'theirs' });

        const { rows, total } = await repository.listDecisionsForUser(userId);

        expect(total).toBe(0);
        expect(rows).toEqual([]);
    });

    it('filters by Task (own link or the run’s), Mission, Agent, kind and search', async () => {
        await seedItem({ title: 'via run', agentRunId: parkedRunId, agentId });
        await seedItem({ kind: 'escalation', title: 'Budget stop', taskId: blockedTaskId });
        await seedItem({ kind: 'approval', title: 'Merge PR', sourceType: 'proposal' });

        const byTask = await repository.listDecisionsForUser(userId, { taskId: missionTaskId });
        expect(byTask.rows.map((row) => row.item.title)).toEqual(['via run']);

        const byMission = await repository.listDecisionsForUser(userId, { missionId: MISSION_ID });
        expect(byMission.rows.map((row) => row.item.title)).toEqual(['via run']);

        const byAgent = await repository.listDecisionsForUser(userId, { agentId });
        expect(byAgent.rows.map((row) => row.item.title)).toEqual(['via run']);
        expect(byAgent.rows[0].agentName).toBe('Researcher');

        const byKind = await repository.listDecisionsForUser(userId, { kind: 'approval' });
        expect(byKind.rows.map((row) => row.item.title)).toEqual(['Merge PR']);

        const notice = await repository.listDecisionsForUser(userId, { kind: 'notice' });
        expect(notice).toEqual({ rows: [], total: 0, hasMore: false });

        const bySearch = await repository.listDecisionsForUser(userId, { search: 'budget' });
        expect(bySearch.rows.map((row) => row.item.title)).toEqual(['Budget stop']);

        const literalPercent = await repository.listDecisionsForUser(userId, { search: '%' });
        expect(literalPercent.total).toBe(0);
    });

    it('reads approval facts from the linked proposal', async () => {
        const proposals = dataSource.getRepository(AgentActionProposal);
        const proposal = await proposals.save(
            proposals.create({
                userId,
                agentId,
                actionType: 'send_message',
                title: 'Email the customer',
                payload: {},
                riskFlags: ['destructive'],
                status: 'pending',
                createdAt: nextDate(),
                updatedAt: nextDate(),
            } as Partial<AgentActionProposal>),
        );
        await seedItem({
            kind: 'approval',
            sourceType: 'proposal',
            title: 'Email the customer',
            proposalId: proposal.id,
        });

        const { rows } = await repository.listDecisionsForUser(userId);

        expect(rows[0].actionType).toBe('send_message');
        expect(rows[0].riskFlags).toEqual(['destructive']);
    });

    it('pages with a total and clamps the page size', async () => {
        for (let index = 0; index < 5; index += 1) {
            await seedItem({ title: `q${index}` });
        }

        const page = await repository.listDecisionsForUser(userId, { limit: 2, offset: 2 });
        expect(page.total).toBe(5);
        expect(page.rows.map((row) => row.item.title)).toEqual(['q2', 'q3']);

        const clamped = await repository.listDecisionsForUser(userId, { limit: 0 });
        expect(clamped.rows).toHaveLength(1);
    });

    it('counts only decisions raised at or before an instant (Home overdue count)', async () => {
        const old = await seedItem({ title: 'old' });
        const edge = await seedItem({ title: 'edge' });
        await seedItem({ title: 'young' });
        await seedItem({ kind: 'notice', title: 'old notice', createdAt: old.createdAt });

        const page = await repository.listDecisionsForUser(userId, {
            createdAtOrBefore: edge.createdAt,
            limit: 1,
        });

        expect(page.total).toBe(2);
        const unfiltered = await repository.listDecisionsForUser(userId, { limit: 1 });
        expect(unfiltered.total).toBe(3);
    });

    describe('keyset paging (`after`) over a queue that changes between reads', () => {
        /** The `after` position of a row exactly as a caller read it. */
        function positionOf(row: InboxDecisionRow, sortAt: Date = row.item.createdAt) {
            return {
                id: row.item.id,
                blockingRank: row.blockingRank,
                confidenceRank: row.confidenceRank,
                sortAt,
            };
        }

        const titles = (rows: InboxDecisionRow[]) => rows.map((row) => row.item.title);

        it('never skips the next decision when a loaded one is answered elsewhere', async () => {
            for (const title of ['A', 'B', 'C', 'D', 'E']) await seedItem({ title });

            const first = await repository.listDecisionsForUser(userId, { limit: 2 });
            expect(titles(first.rows)).toEqual(['A', 'B']);
            expect(first.hasMore).toBe(true);

            // B is answered through another door before "Load more".
            await items.update({ id: first.rows[1].item.id }, { status: 'answered' });

            const offsetPage = await repository.listDecisionsForUser(userId, {
                limit: 2,
                offset: 2,
            });
            // What an offset does: C slid to position 2 and is skipped.
            expect(titles(offsetPage.rows)).toEqual(['D', 'E']);

            const next = await repository.listDecisionsForUser(userId, {
                limit: 2,
                after: positionOf(first.rows[1]),
            });
            expect(titles(next.rows)).toEqual(['C', 'D']);
            expect(next.hasMore).toBe(true);
            // The count still reports the whole (filtered) queue.
            expect(next.total).toBe(4);

            const last = await repository.listDecisionsForUser(userId, {
                limit: 2,
                after: positionOf(next.rows[1]),
            });
            expect(titles(last.rows)).toEqual(['E']);
            expect(last.hasMore).toBe(false);
        });

        it('neither repeats nor skips when a higher-ranked decision arrives between pages', async () => {
            for (const title of ['A', 'B', 'C', 'D']) await seedItem({ title });
            const first = await repository.listDecisionsForUser(userId, { limit: 2 });

            // A run parks on a brand-new question: it ranks above everything.
            await seedItem({ title: 'urgent', agentRunId: parkedRunId });

            const next = await repository.listDecisionsForUser(userId, {
                limit: 2,
                after: positionOf(first.rows[1]),
            });
            expect(titles(next.rows)).toEqual(['C', 'D']);
            expect(next.hasMore).toBe(false);
        });

        it('keeps its place when the last loaded row stops blocking', async () => {
            const runs = dataSource.getRepository(AgentRun);
            const ownRun = await runs.save(
                runs.create({
                    userId,
                    agentId,
                    triggerKind: 'task',
                    status: 'completed',
                    gateAttempts: 0,
                    persistent: false,
                    awaitingInput: true,
                    interruptRequested: false,
                } as Partial<AgentRun>),
            );
            await seedItem({ title: 'blocking-1', agentRunId: ownRun.id });
            await seedItem({ title: 'blocking-2', agentRunId: parkedRunId });
            await seedItem({ title: 'plain' });

            const first = await repository.listDecisionsForUser(userId, { limit: 1 });
            expect(titles(first.rows)).toEqual(['blocking-1']);
            expect(first.rows[0].blockingRank).toBe(1);

            // The run behind the loaded row resumes: that row now ranks last.
            await runs.update({ id: ownRun.id }, { awaitingInput: false });

            const next = await repository.listDecisionsForUser(userId, {
                limit: 5,
                after: positionOf(first.rows[0]),
            });
            // The position is where the row WAS: blocking-2 is not skipped;
            // the moved row may repeat, and callers de-duplicate by id.
            expect(titles(next.rows)).toEqual(['blocking-2', 'blocking-1', 'plain']);
        });

        it('walks rows that share a timestamp one at a time without a gap', async () => {
            const same = new Date('2026-08-20T10:00:00.000Z');
            for (const title of ['t1', 't2', 't3', 't4']) {
                await seedItem({ title, createdAt: same });
            }
            const expected = titles((await repository.listDecisionsForUser(userId)).rows);

            const walked: string[] = [];
            let after: ReturnType<typeof positionOf> | undefined;
            for (let guard = 0; guard < 10; guard += 1) {
                const page = await repository.listDecisionsForUser(userId, { limit: 1, after });
                walked.push(...titles(page.rows));
                if (!page.hasMore) break;
                after = positionOf(page.rows[0]);
            }
            expect(walked).toEqual(expected);
            expect([...walked].sort()).toEqual(['t1', 't2', 't3', 't4']);
        });

        it('walks mixed confidence bands row by row in ranked order', async () => {
            const escalations = dataSource.getRepository(AgentEscalation);
            const scored = async (title: string, confidence: number) => {
                const escalation = await escalations.save(
                    escalations.create({
                        userId,
                        reasonCode: 'gate-exhausted',
                        status: 'open',
                        summary: title,
                        decisionNeeded: 'd',
                        confidence,
                        confidenceSource: 'heuristic',
                    } as Partial<AgentEscalation>),
                );
                await seedItem({ kind: 'escalation', title, escalationId: escalation.id });
            };
            await scored('s-0.73-old', 0.73);
            await seedItem({ title: 'unscored' });
            await scored('s-0.1', 0.1);
            await scored('s-0.73-new', 0.73);
            const expected = titles((await repository.listDecisionsForUser(userId)).rows);
            expect(expected).toEqual(['s-0.73-old', 's-0.73-new', 'unscored', 's-0.1']);

            const walked: string[] = [];
            let after: ReturnType<typeof positionOf> | undefined;
            for (let guard = 0; guard < 10; guard += 1) {
                const page = await repository.listDecisionsForUser(userId, { limit: 1, after });
                walked.push(...titles(page.rows));
                if (!page.hasMore) break;
                after = positionOf(page.rows[0]);
            }
            expect(walked).toEqual(expected);
        });

        it('falls back to the carried timestamp when the last loaded row was deleted', async () => {
            for (const title of ['A', 'B', 'C', 'D']) await seedItem({ title });
            const first = await repository.listDecisionsForUser(userId, { limit: 2 });

            await repository.deleteOwned(first.rows[1].item.id, userId);

            const next = await repository.listDecisionsForUser(userId, {
                limit: 5,
                after: positionOf(first.rows[1]),
            });
            expect(titles(next.rows)).toEqual(['C', 'D']);
        });

        it('pages the answered tab without a gap when many answers share a millisecond', async () => {
            const answeredAt = new Date('2026-08-21T09:00:00.000Z');
            for (const title of ['x1', 'x2', 'x3', 'x4', 'x5']) {
                await seedItem({ title, status: 'answered', answeredAt });
            }
            const expected = titles(
                (await repository.listDecisionsForUser(userId, { status: 'answered' })).rows,
            );

            const first = await repository.listDecisionsForUser(userId, {
                status: 'answered',
                limit: 2,
            });
            // One of the loaded answers is archived before "Load more".
            await items.update({ id: first.rows[0].item.id }, { status: 'archived' });
            const rest = await repository.listDecisionsForUser(userId, {
                status: 'answered',
                limit: 5,
                after: positionOf(first.rows[1], answeredAt),
            });

            expect([...titles(first.rows), ...titles(rest.rows)]).toEqual(expected);
            expect(rest.hasMore).toBe(false);
        });

        it('pages the archived tab and only repeats, never skips, when the cursor row is touched', async () => {
            for (const title of ['r1', 'r2', 'r3', 'r4']) {
                await seedItem({ title, status: 'archived' });
            }
            const all = (await repository.listDecisionsForUser(userId, { status: 'archived' }))
                .rows;
            const ordered = titles(all);

            const first = await repository.listDecisionsForUser(userId, {
                status: 'archived',
                limit: 2,
            });
            expect(titles(first.rows)).toEqual(ordered.slice(0, 2));
            const cursorRow = first.rows[1];

            // The cursor row is touched (re-stamped to now) before "Load more".
            await items.update({ id: cursorRow.item.id }, { unread: false });

            const rest = await repository.listDecisionsForUser(userId, {
                status: 'archived',
                limit: 10,
                after: positionOf(cursorRow, cursorRow.item.updatedAt),
            });
            const seen = new Set([...titles(first.rows), ...titles(rest.rows)]);
            expect([...seen].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
        });
    });

    it('lists the answered tab newest answer first', async () => {
        await seedItem({
            title: 'earlier',
            status: 'answered',
            answeredAt: new Date('2026-08-05T00:00:00.000Z'),
        });
        await seedItem({
            title: 'later',
            status: 'answered',
            answeredAt: new Date('2026-08-06T00:00:00.000Z'),
        });

        const { rows } = await repository.listDecisionsForUser(userId, { status: 'answered' });

        expect(rows.map((row) => row.item.title)).toEqual(['later', 'earlier']);
    });

    it('counts open and blocking decisions and remembers the latest raise', async () => {
        const empty = await repository.countDecisionsForUser(userId);
        expect(empty).toEqual({ open: 0, blocking: 0, lastRaisedAt: null });

        await seedItem({ title: 'parked', agentRunId: parkedRunId });
        await seedItem({ kind: 'escalation', title: 'plain' });
        await seedItem({ kind: 'notice', title: 'fyi' });
        const answered = await seedItem({ kind: 'approval', title: 'done', status: 'answered' });

        const counts = await repository.countDecisionsForUser(userId);

        expect(counts.open).toBe(2);
        expect(counts.blocking).toBe(1);
        expect(counts.lastRaisedAt?.getTime()).toBe(answered.createdAt.getTime());
    });

    it('stamps the first view once and never moves it', async () => {
        const item = await seedItem({ title: 'viewed' });
        const first = new Date('2026-08-10T10:00:00.000Z');

        expect(await repository.stampFirstViewed(item.id, userId, first)).toBe(true);
        expect(
            await repository.stampFirstViewed(item.id, userId, new Date('2026-08-11T00:00:00Z')),
        ).toBe(false);
        expect(await repository.stampFirstViewed(item.id, otherUserId, first)).toBe(false);

        const reread = await items.findOneByOrFail({ id: item.id });
        expect(reread.firstViewedAt?.getTime()).toBe(first.getTime());
    });
});
