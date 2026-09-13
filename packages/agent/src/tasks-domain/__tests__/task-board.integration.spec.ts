import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { User } from '../../entities/user.entity';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
import { TaskRepository } from '../../database/repositories/task.repository';
import { TasksService } from '../tasks.service';
import { TaskBoardService } from '../task-board.service';

/**
 * Task board read model against a real database (in-memory SQLite).
 *
 * The board's promise to its users is arithmetic: a column header is the
 * number of Tasks in that column under the active filters, not the number
 * of cards that happened to fit on a page. A mocked repository can only
 * prove that the right arguments were passed; these cases prove the numbers
 * and the order that actually come back.
 */
describe('Task board read model (integration)', () => {
    let dataSource: DataSource;
    let rows: Repository<Task>;
    let users: Repository<User>;
    let taskRepository: TaskRepository;
    let board: TaskBoardService;
    let captured: string[];
    let slugSeq = 0;

    const NOW = new Date('2026-09-10T12:00:00.000Z');
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    let ownerId: string;
    let strangerId: string;

    async function makeUser(name: string): Promise<string> {
        const user = await users.save(
            users.create({
                username: name,
                email: `${name}@example.com`,
                password: 'x',
            } as Partial<User>),
        );
        return user.id;
    }

    async function seed(
        userId: string,
        overrides: Partial<Task> & { updatedAt?: Date } = {},
    ): Promise<Task> {
        const { updatedAt, ...rest } = overrides;
        slugSeq += 1;
        const saved = await rows.save(
            rows.create({
                userId,
                slug: `T-${slugSeq}`,
                title: `Task ${slugSeq}`,
                status: TaskStatus.TODO,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: userId,
                ...rest,
            } as Partial<Task>),
        );
        // `@UpdateDateColumn` stamps "now" on save; an explicit value in an
        // UPDATE is honoured, which is how a Task is aged.
        const stamp = updatedAt ?? daysAgo(1);
        await rows
            .createQueryBuilder()
            .update(Task)
            .set({ updatedAt: stamp } as never)
            .where('id = :id', { id: saved.id })
            .execute();
        return { ...saved, updatedAt: stamp } as Task;
    }

    beforeAll(async () => {
        captured = [];
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: ['query'],
            logger: {
                logQuery: (query: string) => captured.push(query),
                logQueryError: () => undefined,
                logQuerySlow: () => undefined,
                logSchemaBuild: () => undefined,
                logMigration: () => undefined,
                log: () => undefined,
            },
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(Task);
        users = dataSource.getRepository(User);
        taskRepository = new TaskRepository(rows);
        // Only `list` is exercised; the other collaborators are never touched.
        const stub = {} as never;
        const tasksService = new TasksService(
            taskRepository,
            stub,
            stub,
            stub,
            stub,
            stub,
            stub,
            stub,
        );
        board = new TaskBoardService(tasksService);
        ownerId = await makeUser('board-owner');
        strangerId = await makeUser('board-stranger');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
        captured.length = 0;
    });

    const selectStatements = () =>
        captured.filter(
            (q) => /^SELECT/i.test(q) && q.includes('"tasks"') && !/^SELECT COUNT\(/i.test(q),
        );

    // ── ListTasksFilter additions ────────────────────────────────────────

    describe('TaskRepository.findByUserIdFiltered — board options', () => {
        it('emits the same ORDER BY for an omitted orderBy and for orderBy: updatedAt', async () => {
            await seed(ownerId);
            await taskRepository.findByUserIdFiltered(ownerId, {});
            const omitted = selectStatements().pop()!;
            captured.length = 0;
            await taskRepository.findByUserIdFiltered(ownerId, { orderBy: 'updatedAt' });
            const explicit = selectStatements().pop()!;

            expect(explicit).toBe(omitted);
            expect(omitted).toMatch(/ORDER BY "task"\."updatedAt" DESC/);
        });

        it('adds no board predicate when none of the new fields is set', async () => {
            await seed(ownerId);
            await taskRepository.findByUserIdFiltered(ownerId, {});
            const sql = selectStatements().pop()!;
            expect(sql).not.toMatch(/"parentTaskId" IS NULL/);
            expect(sql).not.toMatch(/"isRecurring" =/);
            expect(sql).not.toMatch(/NOT IN/);
            expect(sql).not.toMatch(/CASE WHEN/);
        });

        it("parentTaskId: 'none' returns only top-level Tasks; a uuid keeps returning children", async () => {
            const parent = await seed(ownerId, { title: 'Parent' });
            await seed(ownerId, { title: 'Child', parentTaskId: parent.id });

            const topLevel = await taskRepository.findByUserIdFiltered(ownerId, {
                parentTaskId: 'none',
            });
            expect(topLevel.rows.map((t) => t.title)).toEqual(['Parent']);
            expect(topLevel.total).toBe(1);

            const children = await taskRepository.findByUserIdFiltered(ownerId, {
                parentTaskId: parent.id,
            });
            expect(children.rows.map((t) => t.title)).toEqual(['Child']);

            const everything = await taskRepository.findByUserIdFiltered(ownerId, {});
            expect(everything.total).toBe(2);
        });

        it('isRecurring true/false splits templates from work; undefined keeps both', async () => {
            await seed(ownerId, { title: 'Template', isRecurring: true });
            await seed(ownerId, { title: 'Work item' });

            const templates = await taskRepository.findByUserIdFiltered(ownerId, {
                isRecurring: true,
            });
            expect(templates.rows.map((t) => t.title)).toEqual(['Template']);
            const work = await taskRepository.findByUserIdFiltered(ownerId, { isRecurring: false });
            expect(work.rows.map((t) => t.title)).toEqual(['Work item']);
            const both = await taskRepository.findByUserIdFiltered(ownerId, {});
            expect(both.total).toBe(2);
        });

        it('terminalUpdatedSince bounds done/cancelled only, in the count and in the rows', async () => {
            await seed(ownerId, { title: 'Old todo', updatedAt: daysAgo(40) });
            await seed(ownerId, {
                title: 'Old done',
                status: TaskStatus.DONE,
                updatedAt: daysAgo(40),
            });
            await seed(ownerId, {
                title: 'Recent done',
                status: TaskStatus.DONE,
                updatedAt: daysAgo(2),
            });
            await seed(ownerId, {
                title: 'Old cancelled',
                status: TaskStatus.CANCELLED,
                updatedAt: daysAgo(40),
            });

            const result = await taskRepository.findByUserIdFiltered(ownerId, {
                terminalUpdatedSince: daysAgo(7),
            });
            expect(result.rows.map((t) => t.title).sort()).toEqual(['Old todo', 'Recent done']);
            expect(result.total).toBe(2);
        });

        it('stalledThenPriority puts the stalled Task first, then p0 → p4, oldest update first', async () => {
            await seed(ownerId, {
                title: 'p3 fresh',
                status: TaskStatus.IN_PROGRESS,
                priority: TaskPriority.P3,
                updatedAt: daysAgo(0.5),
            });
            await seed(ownerId, {
                title: 'p0 newer',
                status: TaskStatus.IN_PROGRESS,
                priority: TaskPriority.P0,
                updatedAt: daysAgo(1),
            });
            await seed(ownerId, {
                title: 'p0 older',
                status: TaskStatus.IN_PROGRESS,
                priority: TaskPriority.P0,
                updatedAt: daysAgo(1.5),
            });
            await seed(ownerId, {
                title: 'p4 stalled',
                status: TaskStatus.IN_PROGRESS,
                priority: TaskPriority.P4,
                latestRunStatus: 'failed',
                updatedAt: daysAgo(5),
            });
            await seed(ownerId, {
                title: 'p4 old but running',
                status: TaskStatus.IN_PROGRESS,
                priority: TaskPriority.P4,
                latestRunStatus: 'running',
                updatedAt: daysAgo(6),
            });

            const { rows: ordered } = await taskRepository.findByUserIdFiltered(ownerId, {
                orderBy: 'stalledThenPriority',
                stallCutoff: daysAgo(2),
            });
            expect(ordered.map((t) => t.title)).toEqual([
                'p4 stalled',
                'p0 older',
                'p0 newer',
                'p3 fresh',
                'p4 old but running',
            ]);
        });

        it('priorityThenUpdated orders p0 first regardless of recency', async () => {
            await seed(ownerId, { title: 'p2', priority: TaskPriority.P2, updatedAt: daysAgo(1) });
            await seed(ownerId, { title: 'p0', priority: TaskPriority.P0, updatedAt: daysAgo(30) });
            await seed(ownerId, { title: 'p1', priority: TaskPriority.P1, updatedAt: daysAgo(3) });

            const { rows: ordered } = await taskRepository.findByUserIdFiltered(ownerId, {
                orderBy: 'priorityThenUpdated',
            });
            expect(ordered.map((t) => t.title)).toEqual(['p0', 'p1', 'p2']);
        });
    });

    // ── TaskBoardService ─────────────────────────────────────────────────

    describe('TaskBoardService', () => {
        it('reports the true column total, not the number of cards returned', async () => {
            for (let i = 0; i < 140; i += 1) await seed(ownerId, { status: TaskStatus.TODO });
            await seed(ownerId, { status: TaskStatus.BACKLOG });

            const result = await board.getBoard(ownerId, { now: NOW });
            const todo = result.columns.find((c) => c.key === 'todo')!;
            const backlog = result.columns.find((c) => c.key === 'backlog')!;

            expect(todo.total).toBe(140);
            expect(todo.cards).toHaveLength(50);
            expect(backlog.total).toBe(1);
            expect(result.columns.map((c) => c.key)).toEqual([
                'backlog',
                'todo',
                'in_progress',
                'in_review',
                'blocked',
                'done',
                'cancelled',
            ]);
            expect(result.columnLimit).toBe(50);
            expect(result.terminalWindowDays).toBe(7);
            expect(result.columns.every((c) => c.failed === false)).toBe(true);
        });

        it('pages one column: getColumn at offset 50 continues exactly where the board stopped', async () => {
            for (let i = 0; i < 60; i += 1) {
                await seed(ownerId, {
                    status: TaskStatus.TODO,
                    priority: i % 2 === 0 ? TaskPriority.P1 : TaskPriority.P3,
                    updatedAt: daysAgo(i / 10),
                });
            }
            const first = await board.getBoard(ownerId, { now: NOW });
            const firstIds = first.columns.find((c) => c.key === 'todo')!.cards.map((t) => t.id);

            const next = await board.getColumn(ownerId, { now: NOW }, 'todo', 50);
            expect(next.total).toBe(60);
            expect(next.offset).toBe(50);
            expect(next.cards).toHaveLength(10);
            expect(next.cards.some((t) => firstIds.includes(t.id))).toBe(false);

            const whole = await board.getColumn(ownerId, { now: NOW, columnLimit: 100 }, 'todo', 0);
            expect(whole.cards.map((t) => t.id)).toEqual([
                ...firstIds,
                ...next.cards.map((t) => t.id),
            ]);
        });

        it('orders a p0 Task with an old update first in its column', async () => {
            await seed(ownerId, { title: 'Recent p3', updatedAt: daysAgo(0.1) });
            await seed(ownerId, {
                title: 'Old p0',
                priority: TaskPriority.P0,
                updatedAt: daysAgo(20),
            });
            await seed(ownerId, {
                title: 'Recent p2',
                priority: TaskPriority.P2,
                updatedAt: daysAgo(0.2),
            });

            const result = await board.getBoard(ownerId, { now: NOW });
            const todo = result.columns.find((c) => c.key === 'todo')!;
            expect(todo.cards[0].title).toBe('Old p0');
        });

        it('applies a filter to every column and to every count', async () => {
            await seed(ownerId, { status: TaskStatus.TODO, labels: ['pricing'] });
            await seed(ownerId, { status: TaskStatus.TODO });
            await seed(ownerId, { status: TaskStatus.BLOCKED, labels: ['pricing'] });
            await seed(ownerId, { status: TaskStatus.BLOCKED });

            const result = await board.getBoard(ownerId, { now: NOW, label: 'pricing' });
            const totals = Object.fromEntries(result.columns.map((c) => [c.key, c.total]));
            expect(totals).toMatchObject({ todo: 1, blocked: 1, backlog: 0 });
        });

        it('never shows another user a Task, in a card or in a count', async () => {
            await seed(strangerId, { status: TaskStatus.TODO });
            await seed(strangerId, { status: TaskStatus.DONE, updatedAt: daysAgo(1) });
            await seed(ownerId, { status: TaskStatus.TODO });

            const result = await board.getBoard(ownerId, { now: NOW });
            expect(result.columns.find((c) => c.key === 'todo')!.total).toBe(1);
            expect(result.columns.find((c) => c.key === 'done')!.total).toBe(0);

            const column = await board.getColumn(strangerId, { now: NOW }, 'todo', 0, everScope);
            expect(column.total).toBe(0);
            expect(column.cards).toEqual([]);
        });

        it('keeps the active Organization out of the personal board and vice versa', async () => {
            await seed(ownerId, { title: 'In org', ...everScope });
            await seed(ownerId, { title: 'Personal' });

            const personal = await board.getBoard(
                ownerId,
                { now: NOW },
                {
                    tenantId: null,
                    organizationId: null,
                },
            );
            expect(
                personal.columns.find((c) => c.key === 'todo')!.cards.map((t) => t.title),
            ).toEqual(['Personal']);

            const org = await board.getBoard(ownerId, { now: NOW }, everScope);
            const todo = org.columns.find((c) => c.key === 'todo')!;
            expect(todo.cards.map((t) => t.title)).toEqual(['In org']);
            expect(todo.total).toBe(1);
        });

        it('bounds Done and Cancelled to the terminal window in the count as well as the cards', async () => {
            await seed(ownerId, { status: TaskStatus.DONE, updatedAt: daysAgo(3) });
            await seed(ownerId, { status: TaskStatus.DONE, updatedAt: daysAgo(10) });
            await seed(ownerId, { status: TaskStatus.CANCELLED, updatedAt: daysAgo(10) });
            await seed(ownerId, { status: TaskStatus.TODO, updatedAt: daysAgo(100) });

            const week = await board.getBoard(ownerId, { now: NOW });
            const totals = Object.fromEntries(week.columns.map((c) => [c.key, c.total]));
            expect(totals).toMatchObject({ done: 1, cancelled: 0, todo: 1 });

            const month = await board.getBoard(ownerId, { now: NOW, terminalWindowDays: 30 });
            const monthTotals = Object.fromEntries(month.columns.map((c) => [c.key, c.total]));
            expect(monthTotals).toMatchObject({ done: 2, cancelled: 1 });
        });

        it('keeps sub-tasks, templates and trigger-hidden Tasks off by default; each toggle restores one', async () => {
            const parent = await seed(ownerId, { title: 'Parent' });
            await seed(ownerId, { title: 'Child', parentTaskId: parent.id });
            await seed(ownerId, { title: 'Template', isRecurring: true });
            await seed(ownerId, { title: 'Hidden', hiddenFromBoard: true });

            const titles = async (input: Record<string, unknown>) =>
                (await board.getBoard(ownerId, { now: NOW, ...input })).columns
                    .find((c) => c.key === 'todo')!
                    .cards.map((t) => t.title)
                    .sort();

            expect(await titles({})).toEqual(['Parent']);
            expect(await titles({ includeSubtasks: true })).toEqual(['Child', 'Parent']);
            expect(await titles({ includeTemplates: true })).toEqual(['Parent', 'Template']);
            expect(await titles({ includeHidden: true })).toEqual(['Hidden', 'Parent']);
        });

        it('restricts columns to a status filter without querying the others', async () => {
            await seed(ownerId, { status: TaskStatus.TODO });
            await seed(ownerId, { status: TaskStatus.BLOCKED });
            captured.length = 0;

            const result = await board.getBoard(ownerId, { now: NOW, status: [TaskStatus.TODO] });
            expect(result.columns.find((c) => c.key === 'todo')!.total).toBe(1);
            expect(result.columns.find((c) => c.key === 'blocked')!.total).toBe(0);
            // One count + one page for the only column that can hold a match.
            expect(
                captured.filter((q) => /^SELECT/i.test(q) && q.includes('"tasks"')),
            ).toHaveLength(2);
        });

        it('groups statuses in the focus layout and totals across them', async () => {
            await seed(ownerId, { status: TaskStatus.BACKLOG });
            await seed(ownerId, { status: TaskStatus.TODO });
            await seed(ownerId, { status: TaskStatus.IN_REVIEW });
            await seed(ownerId, { status: TaskStatus.BLOCKED });

            const focus = await board.getBoard(ownerId, { now: NOW, layout: 'focus' });
            expect(focus.columns.map((c) => [c.key, c.total])).toEqual([
                ['backlog', 2],
                ['in_flight', 0],
                ['needs_you', 2],
                ['done', 0],
            ]);
        });

        it('refuses an unknown column key', async () => {
            await expect(board.getColumn(ownerId, { now: NOW }, 'needs_you', 0)).rejects.toThrow(
                /Unknown status board column/,
            );
        });
    });
});
