import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import type { Task, TaskBoardQuery, TaskBoardResult, TaskStatus } from '@/lib/api/tasks';
import { TasksList, type TasksListBoardData } from './TasksList';

/**
 * The Task list's board options — card order and how far back completed
 * Tasks go — rendered through the REAL English catalogue.
 *
 * What is pinned: both orders and all four windows are reachable; on the
 * `/tasks` board a choice is written to the URL (`?sort=`, `?done=`) so a
 * link reproduces it; on a scoped list the order is a local choice that
 * opens on "Recently updated", the order those lists have always shown.
 */

const replace = vi.fn();
let search = '';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => '/en/tasks',
    useSearchParams: () => new URLSearchParams(search),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/app/actions/tasks', () => ({
    getTaskBoardColumnAction: vi.fn(),
    transitionTaskBoardAction: vi.fn(),
    listTaskRunCandidatesAction: vi.fn().mockResolvedValue([]),
    runTasksBatchAction: vi.fn(),
    listTasksWithRunsAction: vi.fn().mockResolvedValue([]),
    runTaskAction: vi.fn(),
    getTaskDiffAction: vi.fn(),
}));

vi.mock('./TaskScopeRowMenu', () => ({ TaskScopeRowMenu: () => null }));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const STATUSES: TaskStatus[] = [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
];

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

function boardData(
    query: TaskBoardQuery,
    cards: Task[] = [],
    result: Partial<TaskBoardResult> = {},
): TasksListBoardData {
    return {
        query,
        filtersActive: true,
        tableHref: '/tasks?view=table',
        result: {
            layout: 'status',
            columnLimit: 50,
            terminalWindowDays: query.terminalWindowDays ?? 7,
            sort: query.sort ?? 'priority',
            columns: STATUSES.map((status) => {
                const own = cards.filter((card) => card.status === status);
                return {
                    key: status,
                    statuses: [status],
                    total: own.length,
                    cards: own,
                    offset: 0,
                    limit: 50,
                    failed: false,
                };
            }),
            ...result,
        },
    };
}

function wrap(node: React.ReactNode) {
    return (
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            {node}
        </NextIntlClientProvider>
    );
}

const group = (testId: string) => screen.getByTestId(testId);
const choice = (testId: string, name: string) =>
    within(group(testId)).getByRole('button', { name });
const pressed = (testId: string) =>
    within(group(testId))
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.textContent);

const todoTitles = () =>
    within(
        screen
            .getAllByTestId('task-board-column')
            .find((element) => element.getAttribute('data-status') === 'todo')!,
    )
        .queryAllByTestId('task-kanban-card')
        .map((card) => within(card).getAllByRole('link')[1].textContent);

const lastReplaceUrl = () => new URL(`http://x${replace.mock.calls.at(-1)![0]}`);

describe('TasksList — board options on the /tasks board', () => {
    beforeEach(() => {
        replace.mockReset();
        search = 'view=board&label=pricing';
    });

    it('opens on Priority and the last 7 days, and offers every other choice', () => {
        render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 7 })}
                />,
            ),
        );

        expect(within(group('task-board-sort')).getByText('Sort')).toBeTruthy();
        expect(pressed('task-board-sort')).toEqual(['Priority']);
        expect(choice('task-board-sort', 'Recently updated')).toBeTruthy();

        expect(within(group('task-board-done-window')).getByText('Completed')).toBeTruthy();
        expect(pressed('task-board-done-window')).toEqual(['7 days']);
        expect(
            within(group('task-board-done-window'))
                .getAllByRole('button')
                .map((button) => button.textContent),
        ).toEqual(['7 days', '30 days', '90 days', 'All time']);
    });

    it('describes each order on its own button', () => {
        render(wrap(<TasksList tasks={[]} view="board" board={boardData({ sort: 'priority' })} />));
        expect(choice('task-board-sort', 'Priority').getAttribute('title')).toBe(
            'Urgent first, then oldest first.',
        );
        expect(choice('task-board-sort', 'Recently updated').getAttribute('title')).toBe(
            'Most recently updated first.',
        );
    });

    it('writes ?sort=updated to the URL, keeping every other parameter, and presses at once', () => {
        render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 7 })}
                />,
            ),
        );

        fireEvent.click(choice('task-board-sort', 'Recently updated'));

        expect(replace).toHaveBeenCalledTimes(1);
        expect(replace.mock.calls[0][1]).toEqual({ scroll: false });
        const url = lastReplaceUrl();
        expect(url.pathname).toBe('/en/tasks');
        expect(url.searchParams.get('sort')).toBe('updated');
        expect(url.searchParams.get('label')).toBe('pricing');
        expect(url.searchParams.get('view')).toBe('board');
        // A sort change alone does not invent a window.
        expect(url.searchParams.has('done')).toBe(false);
        expect(pressed('task-board-sort')).toEqual(['Recently updated']);
        // The board is re-read in the new order.
        expect(screen.getByTestId('task-board-skeleton')).toBeTruthy();
    });

    it.each([
        ['30 days', '30'],
        ['90 days', '90'],
        ['All time', 'all'],
    ])('writes the %s window to the URL as ?done=%s', (label, param) => {
        render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 7 })}
                />,
            ),
        );

        fireEvent.click(choice('task-board-done-window', label));

        const url = lastReplaceUrl();
        expect(url.searchParams.get('done')).toBe(param);
        expect(url.searchParams.get('view')).toBe('board');
        expect(url.searchParams.has('sort')).toBe(false);
        expect(pressed('task-board-done-window')).toEqual([label]);
    });

    it('keeps a first choice in the URL when a second is made before the first read lands', () => {
        render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 7 })}
                />,
            ),
        );

        fireEvent.click(choice('task-board-sort', 'Recently updated'));
        // The URL and the board read still say priority / 7 days.
        fireEvent.click(choice('task-board-done-window', 'All time'));

        expect(replace).toHaveBeenCalledTimes(2);
        const url = lastReplaceUrl();
        expect(url.searchParams.get('sort')).toBe('updated');
        expect(url.searchParams.get('done')).toBe('all');
        expect(pressed('task-board-sort')).toEqual(['Recently updated']);
        expect(pressed('task-board-done-window')).toEqual(['All time']);
    });

    it('does nothing when the choice already in force is clicked', () => {
        render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 7 })}
                />,
            ),
        );
        fireEvent.click(choice('task-board-sort', 'Priority'));
        fireEvent.click(choice('task-board-done-window', '7 days'));
        expect(replace).not.toHaveBeenCalled();
    });

    it('reproduces a linked board: ?sort=updated&done=all presses both and orders and labels the board', () => {
        search = 'view=board&sort=updated&done=all';
        const cards = [
            task({ title: 'Old urgent', priority: 'p0', updatedAt: '2026-08-01T12:00:00.000Z' }),
            task({ title: 'Fresh low', priority: 'p4', updatedAt: '2026-09-09T12:00:00.000Z' }),
        ];
        render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'updated', terminalWindowDays: 'all' }, cards)}
                />,
            ),
        );

        expect(pressed('task-board-sort')).toEqual(['Recently updated']);
        expect(pressed('task-board-done-window')).toEqual(['All time']);
        expect(todoTitles()).toEqual(['Fresh low', 'Old urgent']);
        const done = screen
            .getAllByTestId('task-board-column')
            .find((element) => element.getAttribute('data-status') === 'done')!;
        expect(within(done).getByTestId('task-board-column-window').textContent).toBe('All time');
    });

    it('lets the pending choice lapse once the board read for it arrives', () => {
        const view = render(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 7 })}
                />,
            ),
        );
        fireEvent.click(choice('task-board-done-window', 'All time'));
        expect(screen.getByTestId('task-board-skeleton')).toBeTruthy();

        search = 'view=board&done=all';
        view.rerender(
            wrap(
                <TasksList
                    tasks={[]}
                    view="board"
                    board={boardData({ sort: 'priority', terminalWindowDays: 'all' })}
                />,
            ),
        );
        expect(screen.queryByTestId('task-board-skeleton')).toBeNull();
        expect(pressed('task-board-done-window')).toEqual(['All time']);
        expect(screen.getByTestId('task-board')).toBeTruthy();
    });

    it('shows no board options in the Cards or Table views', () => {
        search = 'view=cards';
        render(wrap(<TasksList tasks={[task()]} view="cards" />));
        expect(screen.queryByTestId('task-board-options')).toBeNull();
    });
});

describe('TasksList — board order on a scoped Mission / Work / Idea list', () => {
    beforeEach(() => {
        replace.mockReset();
        search = '';
    });

    const scoped = [
        task({ title: 'Old urgent', priority: 'p0', updatedAt: '2026-08-01T12:00:00.000Z' }),
        task({ title: 'Fresh low', priority: 'p4', updatedAt: '2026-09-09T12:00:00.000Z' }),
        task({ title: 'Middle high', priority: 'p1', updatedAt: '2026-09-01T12:00:00.000Z' }),
    ];

    function openScopedBoard() {
        render(wrap(<TasksList tasks={scoped} scope={{ key: 'missionId', id: 'mission-1' }} />));
        fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    }

    it('opens on Recently updated, the order the list has always shown', () => {
        openScopedBoard();
        expect(pressed('task-board-sort')).toEqual(['Recently updated']);
        expect(todoTitles()).toEqual(['Fresh low', 'Middle high', 'Old urgent']);
    });

    it('offers Priority as a local choice that re-orders without touching the URL', () => {
        openScopedBoard();
        fireEvent.click(choice('task-board-sort', 'Priority'));
        expect(pressed('task-board-sort')).toEqual(['Priority']);
        expect(todoTitles()).toEqual(['Old urgent', 'Middle high', 'Fresh low']);

        fireEvent.click(choice('task-board-sort', 'Recently updated'));
        expect(todoTitles()).toEqual(['Fresh low', 'Middle high', 'Old urgent']);
        expect(replace).not.toHaveBeenCalled();
    });

    it('offers no completed-Task window, because a scoped list is not windowed', () => {
        openScopedBoard();
        expect(screen.queryByTestId('task-board-done-window')).toBeNull();
    });
});
