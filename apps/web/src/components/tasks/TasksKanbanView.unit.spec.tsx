import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import type { Task, TaskStatus } from '@/lib/api/tasks';
import { TasksKanbanView, type TasksKanbanViewProps } from './TasksKanbanView';

/**
 * The Task board, rendered through the REAL English catalogue, so every
 * string it shows is proven to resolve — a missing key would render the raw
 * key path and fail these assertions.
 */

const transitionTaskBoardAction = vi.fn();
const listTaskRunCandidatesAction = vi.fn();
const runTasksBatchAction = vi.fn();
const toastError = vi.fn();

vi.mock('@/app/actions/tasks', () => ({
    transitionTaskBoardAction: (...args: unknown[]) => transitionTaskBoardAction(...args),
    listTaskRunCandidatesAction: (...args: unknown[]) => listTaskRunCandidatesAction(...args),
    runTasksBatchAction: (...args: unknown[]) => runTasksBatchAction(...args),
    listTasksWithRunsAction: vi.fn().mockResolvedValue([]),
    runTaskAction: vi.fn(),
    getTaskDiffAction: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

let seq = 0;
function task(overrides: Partial<Task> = {}): Task {
    seq += 1;
    return {
        id: `task-${seq}`,
        slug: `T-${seq}`,
        title: `Task ${seq}`,
        status: 'todo',
        priority: 'p3',
        labels: null,
        updatedAt: '2026-09-09T12:00:00.000Z',
        branchRef: null,
        prNumber: null,
        run: null,
        ...overrides,
    } as Task;
}

function renderBoard(props: TasksKanbanViewProps) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TasksKanbanView {...props} />
        </NextIntlClientProvider>,
    );
}

const column = (status: TaskStatus) =>
    screen
        .getAllByTestId('task-board-column')
        .find((element) => element.getAttribute('data-status') === status)!;

const countOf = (status: TaskStatus) =>
    within(column(status)).getByTestId('task-board-column-count').textContent;

const cardsIn = (status: TaskStatus) => within(column(status)).queryAllByTestId('task-kanban-card');

describe('TasksKanbanView', () => {
    beforeEach(() => {
        transitionTaskBoardAction.mockReset();
        listTaskRunCandidatesAction.mockReset().mockResolvedValue([{ source: 'task' }]);
        runTasksBatchAction.mockReset();
        toastError.mockReset();
    });

    describe('with server totals', () => {
        it('shows each column’s true total, not the number of cards it holds', () => {
            renderBoard({
                tasks: [task(), task()],
                totals: { todo: 140, backlog: 3 },
                loadColumn: vi.fn(),
                terminalWindowDays: 7,
            });

            expect(countOf('todo')).toBe('140');
            expect(cardsIn('todo')).toHaveLength(2);
            expect(countOf('backlog')).toBe('3');
            expect(countOf('blocked')).toBe('0');
            expect(
                within(column('todo')).getByTestId('task-board-column-showing').textContent,
            ).toBe('Showing 2 of 140');
            // The column announces its name and its live total.
            expect(column('todo').getAttribute('aria-label')).toBe('To do, 140 Tasks');
        });

        it('names the seven columns from the translated status catalogue', () => {
            renderBoard({ tasks: [], totals: {}, loadColumn: vi.fn() });
            const names = screen
                .getAllByTestId('task-board-column')
                .map((element) => element.getAttribute('aria-label'));
            expect(names).toEqual([
                'Backlog, 0 Tasks',
                'To do, 0 Tasks',
                'In progress, 0 Tasks',
                'In review, 0 Tasks',
                'Blocked, 0 Tasks',
                'Done, 0 Tasks',
                'Cancelled, 0 Tasks',
            ]);
        });

        it('pages ONE column: show more appends to it and leaves every other column alone', async () => {
            const more = [task({ title: 'Page two A' }), task({ title: 'Page two B' })];
            const loadColumn = vi.fn().mockResolvedValue({ total: 4, cards: more });
            renderBoard({
                tasks: [
                    task({ title: 'First A' }),
                    task({ title: 'First B' }),
                    task({ status: 'blocked', title: 'Blocked one' }),
                ],
                totals: { todo: 4, blocked: 9 },
                pageSize: 2,
                loadColumn,
            });

            const button = within(column('todo')).getByTestId('task-board-show-more');
            expect(button.textContent).toContain('Show 2 more');
            fireEvent.click(button);

            await waitFor(() => expect(cardsIn('todo')).toHaveLength(4));
            expect(loadColumn).toHaveBeenCalledTimes(1);
            expect(loadColumn).toHaveBeenCalledWith('todo', 2);
            expect(countOf('todo')).toBe('4');
            expect(within(column('todo')).queryByTestId('task-board-show-more')).toBeNull();
            // Untouched neighbour.
            expect(cardsIn('blocked')).toHaveLength(1);
            expect(countOf('blocked')).toBe('9');
        });

        it('slots a paged-in Urgent card ahead of the cards already shown', async () => {
            const loadColumn = vi.fn().mockResolvedValue({
                total: 3,
                cards: [task({ title: 'Late urgent', priority: 'p0' })],
            });
            renderBoard({
                tasks: [task({ title: 'Normal A' }), task({ title: 'Normal B' })],
                totals: { todo: 3 },
                pageSize: 2,
                loadColumn,
            });
            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            await waitFor(() => expect(cardsIn('todo')).toHaveLength(3));
            expect(within(cardsIn('todo')[0]).getByText('Late urgent')).toBeTruthy();
        });

        it('says so when a column page fails, without losing the cards already shown', async () => {
            renderBoard({
                tasks: [task()],
                totals: { todo: 60 },
                loadColumn: vi.fn().mockResolvedValue(null),
            });
            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            expect(
                await within(column('todo')).findByText("Couldn't load more. Try again."),
            ).toBeTruthy();
            expect(cardsIn('todo')).toHaveLength(1);
        });

        it('shows a failed column’s error panel while the rest of the board renders', () => {
            renderBoard({
                tasks: [task({ title: 'Still here' })],
                totals: { todo: 1 },
                failedStatuses: ['blocked'],
                loadColumn: vi.fn(),
            });
            expect(
                within(column('blocked')).getByTestId('task-board-column-error').textContent,
            ).toContain("Couldn't load this column.");
            expect(within(column('todo')).getByText('Still here')).toBeTruthy();
        });

        it('states the terminal window on Done and Cancelled, including when they are empty', () => {
            renderBoard({ tasks: [], totals: {}, terminalWindowDays: 7, loadColumn: vi.fn() });
            expect(within(column('done')).getByText('Last 7 days')).toBeTruthy();
            expect(
                within(column('done')).getByText('Nothing finished in the last 7 days.'),
            ).toBeTruthy();
            expect(
                within(column('cancelled')).getByText('Nothing cancelled in the last 7 days.'),
            ).toBeTruthy();
            expect(within(column('in_progress')).getByText('Nothing running.')).toBeTruthy();
        });

        it('says "All time" on Done and Cancelled under the all-time window, and claims no day count', () => {
            renderBoard({ tasks: [], totals: {}, terminalWindowDays: 'all', loadColumn: vi.fn() });
            expect(within(column('done')).getByTestId('task-board-column-window').textContent).toBe(
                'All time',
            );
            expect(
                within(column('cancelled')).getByTestId('task-board-column-window').textContent,
            ).toBe('All time');
            expect(within(column('done')).getByText('Nothing finished.')).toBeTruthy();
            expect(within(column('cancelled')).getByText('Nothing cancelled.')).toBeTruthy();
            expect(within(column('done')).queryByText(/Last \d+ days/)).toBeNull();
            // Only the terminal columns state a window.
            expect(within(column('todo')).queryByTestId('task-board-column-window')).toBeNull();
        });

        it.each([
            [30, 'Last 30 days'],
            [90, 'Last 90 days'],
        ])('states a %s-day window in the header it was chosen for', (days, text) => {
            renderBoard({ tasks: [], totals: {}, terminalWindowDays: days, loadColumn: vi.fn() });
            expect(within(column('done')).getByTestId('task-board-column-window').textContent).toBe(
                text,
            );
        });

        it("slots a paged-in card by recency under sort 'updated', not by priority", async () => {
            const loadColumn = vi.fn().mockResolvedValue({
                total: 3,
                cards: [
                    task({
                        title: 'Late urgent',
                        priority: 'p0',
                        updatedAt: '2026-08-01T12:00:00.000Z',
                    }),
                ],
            });
            renderBoard({
                tasks: [
                    task({ title: 'Newest', updatedAt: '2026-09-09T12:00:00.000Z' }),
                    task({ title: 'Older', updatedAt: '2026-09-05T12:00:00.000Z' }),
                ],
                totals: { todo: 3 },
                pageSize: 2,
                sort: 'updated',
                loadColumn,
            });
            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            await waitFor(() => expect(cardsIn('todo')).toHaveLength(3));
            expect(
                cardsIn('todo').map((card) => within(card).getAllByRole('link')[1].textContent),
            ).toEqual(['Newest', 'Older', 'Late urgent']);
        });

        it('moves a total with an optimistic move, and back when the server refuses it', async () => {
            let settle: (value: unknown) => void = () => undefined;
            transitionTaskBoardAction.mockImplementation(
                () => new Promise((resolve) => (settle = resolve)),
            );
            const movable = task({ title: 'Movable' });
            renderBoard({ tasks: [movable], totals: { todo: 5, blocked: 2 }, loadColumn: vi.fn() });

            const card = cardsIn('todo')[0];
            fireEvent.click(within(card).getByRole('button', { name: 'Move →' }));
            fireEvent.click(within(card).getByRole('button', { name: 'Blocked' }));

            await waitFor(() => expect(countOf('blocked')).toBe('3'));
            expect(countOf('todo')).toBe('4');

            await act(async () => {
                settle({
                    ok: false,
                    code: 'CONFLICT',
                    message: 'Task cannot transition to blocked — has 2 open blocker(s).',
                });
            });

            await waitFor(() => expect(countOf('todo')).toBe('5'));
            expect(countOf('blocked')).toBe('2');
            expect(within(cardsIn('todo')[0]).getByRole('alert').textContent).toBe(
                'Task cannot transition to blocked — has 2 open blocker(s).',
            );
        });

        const moveCard = (status: TaskStatus, title: string, to: string) => {
            const card = cardsIn(status).find((element) => within(element).queryByText(title))!;
            fireEvent.click(within(card).getByRole('button', { name: 'Move →' }));
            fireEvent.click(within(card).getByRole('button', { name: to }));
        };

        it('reads the next page from the server’s position, not from the cards shown, after a card is moved in', async () => {
            const moved = task({ status: 'backlog', title: 'Moved in' });
            transitionTaskBoardAction.mockResolvedValue({
                ok: true,
                // The move stamps the Task: under priority order it now sits
                // after both To do cards read so far, beyond the first page.
                task: { ...moved, status: 'todo', updatedAt: '2026-09-10T12:00:00.000Z' },
            });
            const loadColumn = vi.fn().mockResolvedValue({
                total: 6,
                cards: [task({ title: 'Todo C' }), task({ title: 'Todo D' })],
            });
            renderBoard({
                tasks: [task({ title: 'Todo A' }), task({ title: 'Todo B' }), moved],
                totals: { todo: 5, backlog: 1 },
                pageSize: 2,
                loadColumn,
            });

            moveCard('backlog', 'Moved in', 'To do');
            await waitFor(() => expect(transitionTaskBoardAction).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(countOf('todo')).toBe('6'));
            expect(cardsIn('todo')).toHaveLength(3);

            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            await waitFor(() => expect(cardsIn('todo')).toHaveLength(5));
            // Offset 3 (the cards shown) would have skipped the server's row 2.
            expect(loadColumn).toHaveBeenCalledWith('todo', 2);
            expect(within(column('todo')).getByText('Todo C')).toBeTruthy();
        });

        it('holds a column page until a move still landing has settled, then reads past it', async () => {
            let settle: (value: unknown) => void = () => undefined;
            transitionTaskBoardAction.mockImplementation(
                () => new Promise((resolve) => (settle = resolve)),
            );
            const moved = task({ status: 'backlog', title: 'Moved in' });
            const loadColumn = vi.fn().mockResolvedValue({ total: 6, cards: [] });
            renderBoard({
                tasks: [task({ title: 'Todo A' }), task({ title: 'Todo B' }), moved],
                totals: { todo: 5, backlog: 1 },
                pageSize: 2,
                sort: 'updated',
                loadColumn,
            });

            moveCard('backlog', 'Moved in', 'To do');
            await waitFor(() => expect(cardsIn('todo')).toHaveLength(3));
            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            await act(async () => undefined);
            expect(loadColumn).not.toHaveBeenCalled();

            await act(async () => {
                // Newest update: under 'updated' it is the column's first row,
                // inside the rows already read.
                settle({
                    ok: true,
                    task: { ...moved, status: 'todo', updatedAt: '2026-09-10T12:00:00.000Z' },
                });
            });
            await waitFor(() => expect(loadColumn).toHaveBeenCalledTimes(1));
            expect(loadColumn).toHaveBeenCalledWith('todo', 3);
        });

        it('reads a column from one row earlier after a card read from it is moved out', async () => {
            const leaving = task({ title: 'Leaving' });
            transitionTaskBoardAction.mockResolvedValue({
                ok: true,
                task: { ...leaving, status: 'blocked', updatedAt: '2026-09-10T12:00:00.000Z' },
            });
            const loadColumn = vi.fn().mockResolvedValue({ total: 4, cards: [] });
            renderBoard({
                tasks: [leaving, task({ title: 'Staying A' }), task({ title: 'Staying B' })],
                totals: { todo: 5 },
                pageSize: 3,
                loadColumn,
            });

            moveCard('todo', 'Leaving', 'Blocked');
            await waitFor(() => expect(transitionTaskBoardAction).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(cardsIn('blocked')).toHaveLength(1));
            await act(async () => undefined);

            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            await waitFor(() => expect(loadColumn).toHaveBeenCalledTimes(1));
            expect(loadColumn).toHaveBeenCalledWith('todo', 2);
        });
    });

    describe('handed a plain list (scoped Task lists)', () => {
        it('counts each column from the cards it holds and reveals more locally', async () => {
            const loadColumn = undefined;
            const many = Array.from({ length: 20 }, (_, index) => task({ title: `Row ${index}` }));
            renderBoard({ tasks: many, loadColumn });

            expect(countOf('todo')).toBe('20');
            expect(cardsIn('todo')).toHaveLength(15);
            expect(within(column('todo')).queryByTestId('task-board-column-showing')).toBeNull();
            fireEvent.click(within(column('todo')).getByTestId('task-board-show-more'));
            await waitFor(() => expect(cardsIn('todo')).toHaveLength(20));
        });

        it('orders each column Urgent first, then the oldest update first', () => {
            renderBoard({
                tasks: [
                    task({
                        title: 'Fresh normal',
                        priority: 'p3',
                        updatedAt: '2026-09-09T12:00:00.000Z',
                    }),
                    task({
                        title: 'Old urgent',
                        priority: 'p0',
                        updatedAt: '2026-08-01T12:00:00.000Z',
                    }),
                    task({
                        title: 'Old normal',
                        priority: 'p3',
                        updatedAt: '2026-09-01T12:00:00.000Z',
                    }),
                    task({ title: 'Low', priority: 'p4', updatedAt: '2026-07-01T12:00:00.000Z' }),
                    task({ title: 'High', priority: 'p1', updatedAt: '2026-09-09T13:00:00.000Z' }),
                ],
            });
            expect(
                cardsIn('todo').map((card) => within(card).getAllByRole('link')[1].textContent),
            ).toEqual(['Old urgent', 'High', 'Old normal', 'Fresh normal', 'Low']);
        });

        it("orders each column most recently updated first with sort 'updated'", () => {
            renderBoard({
                sort: 'updated',
                tasks: [
                    task({
                        title: 'Old urgent',
                        priority: 'p0',
                        updatedAt: '2026-08-01T12:00:00.000Z',
                    }),
                    task({
                        title: 'Fresh normal',
                        priority: 'p3',
                        updatedAt: '2026-09-09T12:00:00.000Z',
                    }),
                    task({ title: 'Low', priority: 'p4', updatedAt: '2026-07-01T12:00:00.000Z' }),
                    task({ title: 'High', priority: 'p1', updatedAt: '2026-09-09T13:00:00.000Z' }),
                ],
            });
            expect(
                cardsIn('todo').map((card) => within(card).getAllByRole('link')[1].textContent),
            ).toEqual(['High', 'Fresh normal', 'Old urgent', 'Low']);
        });

        it('re-orders the cards it holds when the sort changes, without a read', () => {
            const tasks = [
                task({
                    title: 'Old urgent',
                    priority: 'p0',
                    updatedAt: '2026-08-01T12:00:00.000Z',
                }),
                task({ title: 'Fresh low', priority: 'p4', updatedAt: '2026-09-09T12:00:00.000Z' }),
            ];
            const titles = () =>
                cardsIn('todo').map((card) => within(card).getAllByRole('link')[1].textContent);
            const view = renderBoard({ tasks, sort: 'updated' });
            expect(titles()).toEqual(['Fresh low', 'Old urgent']);
            view.rerender(
                <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                    <TasksKanbanView tasks={tasks} sort="priority" />
                </NextIntlClientProvider>,
            );
            expect(titles()).toEqual(['Old urgent', 'Fresh low']);
        });

        it('describes the active order in the column header tooltip', () => {
            const header = () => within(column('todo')).getByTestId('task-board-column-header');
            const view = renderBoard({ tasks: [], sort: 'updated' });
            expect(header().getAttribute('title')).toBe('Most recently updated first.');
            view.rerender(
                <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                    <TasksKanbanView tasks={[]} />
                </NextIntlClientProvider>,
            );
            expect(header().getAttribute('title')).toBe('Urgent first, then oldest first.');
        });

        it('does not claim a time window for an unwindowed Done column', () => {
            renderBoard({ tasks: [] });
            expect(within(column('done')).getByText('Nothing finished.')).toBeTruthy();
            expect(within(column('done')).queryByText(/Last \d+ days/)).toBeNull();
        });
    });

    it('offers only the legal moves, labelled from the status catalogue', () => {
        renderBoard({ tasks: [task({ status: 'backlog' })] });
        const card = cardsIn('backlog')[0];
        fireEvent.click(within(card).getByRole('button', { name: 'Move →' }));
        const targets = within(card)
            .getAllByRole('button')
            .filter((button) => button.getAttribute('data-status'))
            .map((button) => button.textContent);
        expect(targets).toEqual(['To do', 'Cancelled']);
    });

    it('offers no Move affordance on a cancelled card', () => {
        renderBoard({ tasks: [task({ status: 'cancelled' })] });
        expect(
            within(cardsIn('cancelled')[0]).queryByRole('button', { name: 'Move →' }),
        ).toBeNull();
    });

    it('shows the server’s reason when a move is refused, and a plain fallback when it gave none', async () => {
        transitionTaskBoardAction.mockResolvedValueOnce({
            ok: false,
            code: 'BAD_REQUEST',
            message: '',
        });
        renderBoard({ tasks: [task({ status: 'todo' })] });
        const card = cardsIn('todo')[0];
        fireEvent.click(within(card).getByRole('button', { name: 'Move →' }));
        fireEvent.click(within(card).getByRole('button', { name: 'Cancelled' }));

        await waitFor(() => expect(cardsIn('todo')).toHaveLength(1));
        expect(within(cardsIn('todo')[0]).getByRole('alert').textContent).toBe(
            "Couldn't move this Task.",
        );
    });

    it('explains, once per drag, why a cancelled Task cannot be dropped anywhere', () => {
        renderBoard({ tasks: [task({ status: 'cancelled' })] });
        const card = cardsIn('cancelled')[0];
        const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '' };
        fireEvent.dragStart(card, { dataTransfer });

        const dropZone = (status: TaskStatus) =>
            column(status).querySelector('.overflow-y-auto') as HTMLElement;
        fireEvent.dragOver(dropZone('todo'), { dataTransfer });
        fireEvent.dragOver(dropZone('in_progress'), { dataTransfer });

        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledWith("A cancelled Task can't be reopened.");
    });

    it('gives the priority chip its translated name as a tooltip', () => {
        renderBoard({ tasks: [task({ priority: 'p0' })] });
        const chip = within(cardsIn('todo')[0]).getByText('p0');
        expect(chip.getAttribute('title')).toBe('Priority: Urgent');
    });
});
