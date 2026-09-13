import { TASK_BOARD_STATUSES, TASK_BOARD_TRANSITIONS } from '@ever-works/contracts';
import { TaskStatus } from '../../entities/task.entity';
import { TaskTransitionService } from '../task-transition.service';
import { TaskBoardService } from '../task-board.service';
import type { TasksService } from '../tasks.service';

/**
 * TaskBoardService — the parts a real database cannot fail on demand:
 * one predicate shared by every column, clamps on every bound, and the
 * per-column failure isolation. The arithmetic itself (true totals, order,
 * scope) is proven against SQLite in `task-board.integration.spec.ts`.
 */
describe('TaskBoardService', () => {
    const NOW = new Date('2026-09-10T12:00:00.000Z');
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function make(list: jest.Mock) {
        return new TaskBoardService({ list } as unknown as TasksService);
    }

    it('hands every column the same predicate, differing only in status, and threads the scope', async () => {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 0 });
        await make(list).getBoard(
            'user-1',
            { now: NOW, label: 'pricing', priority: 'p0' as never },
            scope,
        );

        expect(list).toHaveBeenCalledTimes(7);
        const filters = list.mock.calls.map((call) => {
            const { status: _status, ...rest } = call[1];
            return rest;
        });
        for (const filter of filters) expect(filter).toEqual(filters[0]);
        expect(list.mock.calls.map((call) => call[1].status)).toEqual([...TASK_BOARD_STATUSES]);
        for (const call of list.mock.calls) {
            expect(call[0]).toBe('user-1');
            expect(call[2]).toEqual({ includeRun: true });
            expect(call[3]).toBe(scope);
        }
        expect(filters[0]).toMatchObject({
            label: 'pricing',
            priority: 'p0',
            parentTaskId: 'none',
            isRecurring: false,
            includeHidden: false,
            orderBy: 'stalledThenPriority',
            limit: 50,
            offset: 0,
            terminalUpdatedSince: new Date('2026-09-03T12:00:00.000Z'),
            stallCutoff: new Date('2026-09-08T12:00:00.000Z'),
        });
    });

    it.each([
        ['includeSubtasks', { includeSubtasks: true }, 'parentTaskId', undefined],
        ['includeTemplates', { includeTemplates: true }, 'isRecurring', undefined],
        ['includeHidden', { includeHidden: true }, 'includeHidden', true],
    ])('%s flips exactly one predicate', async (_name, toggle, field, expected) => {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 0 });
        const service = make(list);
        await service.getBoard('user-1', { now: NOW });
        const baseline = { ...list.mock.calls[0][1] };
        list.mockClear();
        await service.getBoard('user-1', { now: NOW, ...toggle });
        const toggled = { ...list.mock.calls[0][1] };

        expect(toggled[field]).toBe(expected);
        delete baseline[field];
        delete toggled[field];
        expect(toggled).toEqual(baseline);
    });

    it('clamps the column limit and the terminal window, and reports what it used', async () => {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 0 });
        const result = await make(list).getBoard('user-1', {
            now: NOW,
            columnLimit: 5000,
            terminalWindowDays: 0,
        });
        expect(result.columnLimit).toBe(100);
        expect(result.terminalWindowDays).toBe(1);
        expect(list.mock.calls[0][1]).toMatchObject({
            limit: 100,
            terminalUpdatedSince: new Date('2026-09-09T12:00:00.000Z'),
        });
    });

    it('takes a column total from the read, never from the number of cards', async () => {
        const list = jest.fn().mockResolvedValue({ rows: [{ id: 't1' }], total: 140 });
        const result = await make(list).getBoard('user-1', { now: NOW });
        expect(result.columns[0]).toMatchObject({ total: 140, failed: false });
        expect(result.columns[0].cards).toHaveLength(1);
    });

    it('degrades one failing column to an empty, failed column while the others render', async () => {
        const list = jest.fn(async (_user: string, filter: { status: string }) => {
            if (filter.status === 'blocked') throw new Error('replica down');
            return { rows: [], total: 3 };
        });
        const result = await make(list).getBoard('user-1', { now: NOW });
        const blocked = result.columns.find((column) => column.key === 'blocked')!;
        expect(blocked).toMatchObject({ failed: true, total: 0, cards: [] });
        expect(result.columns.filter((column) => !column.failed)).toHaveLength(6);
        expect(result.columns.find((column) => column.key === 'todo')!.total).toBe(3);
    });

    it('fails the read only when every column fails', async () => {
        const list = jest.fn().mockRejectedValue(new Error('database unavailable'));
        await expect(make(list).getBoard('user-1', { now: NOW })).rejects.toThrow(
            'database unavailable',
        );
    });

    it('skips the query for a column the status filter rules out', async () => {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 2 });
        const result = await make(list).getBoard('user-1', {
            now: NOW,
            status: [TaskStatus.IN_REVIEW],
        });
        expect(list).toHaveBeenCalledTimes(1);
        expect(list.mock.calls[0][1].status).toBe('in_review');
        expect(result.columns.find((column) => column.key === 'in_review')!.total).toBe(2);
        expect(result.columns.find((column) => column.key === 'todo')!.total).toBe(0);
    });

    it('asks for a grouped column with every status it holds', async () => {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 0 });
        await make(list).getColumn('user-1', { now: NOW, layout: 'focus' }, 'needs_you', 50, scope);
        expect(list).toHaveBeenCalledTimes(1);
        expect(list.mock.calls[0][1]).toMatchObject({
            status: ['in_review', 'blocked'],
            offset: 50,
            limit: 50,
        });
    });

    it('treats a negative or non-finite column offset as the first page', async () => {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 0 });
        const service = make(list);
        await service.getColumn('user-1', { now: NOW }, 'todo', -10);
        await service.getColumn('user-1', { now: NOW }, 'todo', Number.NaN);
        expect(list.mock.calls.map((call) => call[1].offset)).toEqual([0, 0]);
    });

    it('refuses an unknown column key without reading anything', async () => {
        const list = jest.fn();
        await expect(make(list).getColumn('user-1', {}, 'in_flight', 0)).rejects.toThrow(
            'Unknown status board column: in_flight',
        );
        expect(list).not.toHaveBeenCalled();
    });
});

/**
 * The board's shared tables are an affordance mirror of server state. If a
 * status or a transition is added server-side without updating the mirror,
 * the board would silently offer (or hide) moves the server disagrees with.
 */
describe('task board contract mirrors the Task domain', () => {
    it('lists exactly the TaskStatus enum', () => {
        expect(new Set(TASK_BOARD_STATUSES)).toEqual(new Set(Object.values(TaskStatus)));
        expect(TASK_BOARD_STATUSES).toHaveLength(Object.values(TaskStatus).length);
    });

    it('mirrors the transition lattice pair for pair', () => {
        const transitions = Object.create(TaskTransitionService.prototype) as TaskTransitionService;
        for (const from of Object.values(TaskStatus)) {
            for (const to of Object.values(TaskStatus)) {
                expect([from, to, TASK_BOARD_TRANSITIONS[from].includes(to)]).toEqual([
                    from,
                    to,
                    transitions.canTransition(from, to),
                ]);
            }
        }
    });
});
