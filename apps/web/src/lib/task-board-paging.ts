/**
 * Task board — where "show more" continues reading each column.
 *
 * A column's next page is read by OFFSET into the server's order for that
 * column. The cards a column shows are not that offset: an optimistic move
 * adds a card the server may place anywhere in the column, including beyond
 * the rows read so far, and takes one away from the column it left. Using the
 * number of cards shown as the offset therefore skips a server row after a
 * move in (the skipped row is never read again) and re-reads one after a move
 * out.
 *
 * This ledger keeps, per column, the number of rows of the server's order the
 * board has consumed — its cursor — independently of what the column shows:
 *
 *   - a page read at offset N with k cards moves the cursor to N + k;
 *   - a CONFIRMED move out of a column removes a row inside the consumed range
 *     (the card was read from there), so that cursor steps back by one;
 *   - a confirmed move into a column inserts a row, which is inside the
 *     consumed range only when the moved card sorts before the last row read
 *     (or the column was already fully read); only then does the cursor step
 *     forward. Otherwise the card will arrive again with a later page, where
 *     the board's id de-duplication absorbs it.
 *
 * Refused or failed moves change nothing on the server and nothing here.
 * The ledger is exact for the board's own reads and writes as long as they
 * reach the server one at a time — see {@link createTaskBoardSyncQueue}.
 *
 * Client-safe: no server imports.
 */

import {
    compareTaskBoardCards,
    type TaskBoardOrderInput,
    type TaskBoardSort,
} from '@ever-works/contracts';

/** The fields a card needs to be placed in a column: its order keys and id. */
export type TaskBoardPagingCard = TaskBoardOrderInput & { id: string };

interface CountedCard {
    column: string;
    order: TaskBoardPagingCard;
}

export interface TaskBoardPaging {
    /** Rows of each column's server order the board has consumed. */
    cursors: Map<string, number>;
    /** Each column's server total, as last read and adjusted by confirmed moves. */
    totals: Map<string, number>;
    /** Cards inside a column's consumed range, with the order keys they had there. */
    counted: Map<string, CountedCard>;
}

function orderKeys(card: TaskBoardPagingCard): TaskBoardPagingCard {
    return {
        id: card.id,
        status: card.status,
        priority: card.priority,
        latestRunStatus: card.latestRunStatus ?? null,
        updatedAt: card.updatedAt,
    };
}

/**
 * The ledger for a board read: every card handed to the board came from its
 * own column's first page, so each column's cursor starts at its card count.
 */
export function seedTaskBoardPaging(
    cards: readonly TaskBoardPagingCard[],
    totals: Readonly<Partial<Record<string, number>>> | undefined,
): TaskBoardPaging {
    const paging: TaskBoardPaging = { cursors: new Map(), totals: new Map(), counted: new Map() };
    for (const card of cards) {
        const column = String(card.status);
        paging.cursors.set(column, (paging.cursors.get(column) ?? 0) + 1);
        paging.counted.set(card.id, { column, order: orderKeys(card) });
    }
    for (const [column, total] of Object.entries(totals ?? {})) {
        if (typeof total === 'number') paging.totals.set(column, total);
    }
    return paging;
}

/** The offset "show more" reads a column from. */
export function taskBoardNextOffset(paging: TaskBoardPaging, column: string): number {
    return paging.cursors.get(column) ?? 0;
}

/** Record a column page the server returned for a read at `offset`. */
export function recordTaskBoardPage(
    paging: TaskBoardPaging,
    column: string,
    offset: number,
    cards: readonly TaskBoardPagingCard[],
    total: number,
): void {
    paging.cursors.set(column, offset + cards.length);
    paging.totals.set(column, total);
    for (const card of cards) {
        const existing = paging.counted.get(card.id);
        if (!existing || existing.column === column) {
            paging.counted.set(card.id, { column, order: orderKeys(card) });
        }
    }
}

/**
 * Record a move the server CONFIRMED. `moved` is the card as the server
 * returned it — its new `updatedAt` decides where it now sits.
 */
export function recordTaskBoardMove(
    paging: TaskBoardPaging,
    moved: TaskBoardPagingCard,
    from: string,
    to: string,
    now: Date,
    sort: TaskBoardSort,
): void {
    if (from === to) return;

    const previous = paging.counted.get(moved.id);
    if (previous) {
        paging.cursors.set(
            previous.column,
            Math.max(0, (paging.cursors.get(previous.column) ?? 0) - 1),
        );
        paging.counted.delete(moved.id);
    }
    paging.totals.set(from, Math.max(0, (paging.totals.get(from) ?? 0) - 1));

    const cursor = paging.cursors.get(to) ?? 0;
    const totalBefore = paging.totals.get(to) ?? 0;
    paging.totals.set(to, totalBefore + 1);

    const compare = (a: TaskBoardPagingCard, b: TaskBoardPagingCard) =>
        compareTaskBoardCards(a, b, now, undefined, sort);
    let inside = cursor >= totalBefore;
    if (!inside) {
        let lastRead: TaskBoardPagingCard | undefined;
        for (const entry of paging.counted.values()) {
            if (entry.column !== to) continue;
            if (!lastRead || compare(entry.order, lastRead) > 0) lastRead = entry.order;
        }
        inside = lastRead !== undefined && compare(moved, lastRead) < 0;
    }
    if (inside) {
        paging.cursors.set(to, cursor + 1);
        paging.counted.set(moved.id, { column: to, order: orderKeys(moved) });
    }
}

/**
 * Runs the board's server reads and writes one at a time, in the order they
 * were asked for, so a page is never read while a move it depends on is still
 * landing (and a move never lands in the middle of a page read). Work handed
 * to an idle queue starts immediately, in the same tick.
 */
export function createTaskBoardSyncQueue(): <T>(work: () => Promise<T>) => Promise<T> {
    let tail: Promise<void> | null = null;
    return function run<T>(work: () => Promise<T>): Promise<T> {
        const start = (): Promise<T> => {
            try {
                return work();
            } catch (error) {
                return Promise.reject(error);
            }
        };
        const result = tail ? tail.then(start) : start();
        const settled = result.then(
            () => undefined,
            () => undefined,
        );
        tail = settled;
        void settled.then(() => {
            if (tail === settled) tail = null;
        });
        return result;
    };
}
