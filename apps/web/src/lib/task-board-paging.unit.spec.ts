import { describe, expect, it } from 'vitest';
import {
    createTaskBoardSyncQueue,
    recordTaskBoardMove,
    recordTaskBoardPage,
    seedTaskBoardPaging,
    taskBoardNextOffset,
    type TaskBoardPagingCard,
} from './task-board-paging';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function card(id: string, overrides: Partial<TaskBoardPagingCard> = {}): TaskBoardPagingCard {
    return {
        id,
        status: 'todo',
        priority: 'p3',
        latestRunStatus: null,
        updatedAt: hoursAgo(10),
        ...overrides,
    };
}

describe('task board paging ledger', () => {
    it('starts each column at the number of cards its first page returned', () => {
        const paging = seedTaskBoardPaging(
            [card('a'), card('b'), card('c', { status: 'blocked' })],
            { todo: 5, blocked: 1 },
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
        expect(taskBoardNextOffset(paging, 'blocked')).toBe(1);
        expect(taskBoardNextOffset(paging, 'done')).toBe(0);
    });

    it('continues after a page from where that page ended', () => {
        const paging = seedTaskBoardPaging([card('a'), card('b')], { todo: 6 });
        recordTaskBoardPage(paging, 'todo', 2, [card('c'), card('d')], 6);
        expect(taskBoardNextOffset(paging, 'todo')).toBe(4);
    });

    it('does not advance a column for a card moved in that the server places beyond the rows read', () => {
        // Priority order, oldest update first: a card the move just stamped
        // sorts after every same-priority row, beyond the two read so far.
        const paging = seedTaskBoardPaging(
            [
                card('todo-a', { updatedAt: hoursAgo(30) }),
                card('todo-b', { updatedAt: hoursAgo(20) }),
                card('moved', { status: 'backlog' }),
            ],
            { todo: 5, backlog: 1 },
        );
        recordTaskBoardMove(
            paging,
            card('moved', { updatedAt: NOW.toISOString() }),
            'backlog',
            'todo',
            NOW,
            'priority',
        );
        // Not 3: the server's rows 2..4 are still unread, and row 2 is not
        // the moved card.
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
        expect(taskBoardNextOffset(paging, 'backlog')).toBe(0);
    });

    it('advances a column for a card moved in that sorts inside the rows read', () => {
        const paging = seedTaskBoardPaging(
            [
                card('todo-a', { updatedAt: hoursAgo(30) }),
                card('todo-b', { updatedAt: hoursAgo(20) }),
                card('moved', { status: 'backlog', priority: 'p0' }),
            ],
            { todo: 5, backlog: 1 },
        );
        recordTaskBoardMove(
            paging,
            card('moved', { priority: 'p0', updatedAt: NOW.toISOString() }),
            'backlog',
            'todo',
            NOW,
            'priority',
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(3);
    });

    it("advances under sort 'updated', where a just-moved card is the newest row", () => {
        const paging = seedTaskBoardPaging(
            [
                card('todo-a', { updatedAt: hoursAgo(1) }),
                card('todo-b', { updatedAt: hoursAgo(2) }),
                card('moved', { status: 'backlog' }),
            ],
            { todo: 5, backlog: 1 },
        );
        recordTaskBoardMove(
            paging,
            card('moved', { updatedAt: NOW.toISOString() }),
            'backlog',
            'todo',
            NOW,
            'updated',
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(3);
    });

    it('advances a fully read column whatever the moved card sorts as', () => {
        const paging = seedTaskBoardPaging([card('todo-a'), card('moved', { status: 'backlog' })], {
            todo: 1,
            backlog: 1,
        });
        recordTaskBoardMove(
            paging,
            card('moved', { priority: 'p4', updatedAt: NOW.toISOString() }),
            'backlog',
            'todo',
            NOW,
            'priority',
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
    });

    it('steps a column back for a card moved out of the rows read', () => {
        const paging = seedTaskBoardPaging([card('a'), card('b'), card('c')], { todo: 9 });
        recordTaskBoardMove(
            paging,
            card('b', { status: 'blocked' }),
            'todo',
            'blocked',
            NOW,
            'priority',
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
    });

    it('leaves the source alone for a card that was never inside its rows read', () => {
        const paging = seedTaskBoardPaging(
            [
                card('todo-a', { updatedAt: hoursAgo(30) }),
                card('todo-b', { updatedAt: hoursAgo(20) }),
                card('moved', { status: 'backlog' }),
            ],
            { todo: 5, backlog: 1, blocked: 3 },
        );
        const stamped = NOW.toISOString();
        recordTaskBoardMove(
            paging,
            card('moved', { updatedAt: stamped }),
            'backlog',
            'todo',
            NOW,
            'priority',
        );
        // Moved on again before "show more" reached it in To do.
        recordTaskBoardMove(
            paging,
            card('moved', { status: 'blocked', updatedAt: stamped }),
            'todo',
            'blocked',
            NOW,
            'priority',
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
    });

    it('counts a moved-in card once a later page returns it', () => {
        const paging = seedTaskBoardPaging(
            [card('todo-a', { updatedAt: hoursAgo(30) }), card('moved', { status: 'backlog' })],
            { todo: 3, backlog: 1 },
        );
        const moved = card('moved', { updatedAt: NOW.toISOString() });
        recordTaskBoardMove(paging, moved, 'backlog', 'todo', NOW, 'priority');
        expect(taskBoardNextOffset(paging, 'todo')).toBe(1);
        recordTaskBoardPage(
            paging,
            'todo',
            1,
            [card('todo-b', { updatedAt: hoursAgo(20) }), moved],
            4,
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(3);
        // And moving it out again now steps To do back.
        recordTaskBoardMove(
            paging,
            { ...moved, status: 'blocked' },
            'todo',
            'blocked',
            NOW,
            'priority',
        );
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
    });

    it('ignores a move the server reports as no change of column', () => {
        const paging = seedTaskBoardPaging([card('a'), card('b')], { todo: 4 });
        recordTaskBoardMove(paging, card('a'), 'todo', 'todo', NOW, 'priority');
        expect(taskBoardNextOffset(paging, 'todo')).toBe(2);
    });
});

describe('createTaskBoardSyncQueue', () => {
    it('starts work on an idle queue in the same tick', () => {
        const run = createTaskBoardSyncQueue();
        let started = false;
        void run(async () => {
            started = true;
        });
        expect(started).toBe(true);
    });

    it('starts the next work only after the previous one settles, even when it fails', async () => {
        const run = createTaskBoardSyncQueue();
        const log: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const first = run(
            () =>
                new Promise<void>((_, reject) => {
                    log.push('first:start');
                    releaseFirst = () => {
                        log.push('first:end');
                        reject(new Error('refused'));
                    };
                }),
        );
        const second = run(async () => {
            log.push('second:start');
            return 2;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(log).toEqual(['first:start']);

        releaseFirst();
        await expect(first).rejects.toThrow('refused');
        await expect(second).resolves.toBe(2);
        expect(log).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('turns a work function that throws synchronously into a rejection', async () => {
        const run = createTaskBoardSyncQueue();
        await expect(
            run(() => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        await expect(run(async () => 'next')).resolves.toBe('next');
    });
});
