import { BadRequestException } from '@nestjs/common';
import { INBOX_ITEM_STATUSES, type InboxItemStatus } from '@ever-works/contracts';
import type {
    InboxDecisionPageAfter,
    InboxDecisionRow,
} from '../database/repositories/inbox-item.repository';

/**
 * My Decisions — the opaque "Load more" cursor of the decision view.
 *
 * The open queue is ranked over LIVE state (a decision is answered through
 * another door, a new one is raised, a run parks), so an `offset` into a
 * re-ranked queue drifts: a row leaving the queue shifts every later row
 * forward and the next page skips one, a row arriving ahead of the page
 * shifts them back and the next page repeats one. The cursor names the
 * position of the last row the caller holds instead — its tab, its id, and
 * (open tab) the blocking and confidence ranks it had when it was read —
 * so the next page starts right after that row whatever happened ahead of
 * it.
 *
 * The row's own sort timestamp travels too, but only as a fallback: the
 * repository compares against the row's stored value (full database
 * precision) and falls back to the carried millisecond only when that row
 * is gone, with a comparison widened to never skip.
 *
 * Wire shape: base64url of a small JSON object. Opaque to callers — only
 * this module reads or writes it.
 */

interface CursorPayload {
    /** Cursor format version. */
    v: 1;
    /** The tab the cursor was minted on; a cursor never crosses tabs. */
    s: InboxItemStatus;
    /** Id of the last row of the page. */
    id: string;
    /** Open tab: blocking rank as read (1 = work stopped behind it). */
    b: number;
    /** Open tab: confidence rank as read. */
    c: number;
    /** Epoch ms of the row's sort timestamp — the fallback when the row is gone. */
    t: number;
}

/** Longest cursor string accepted — a payload is well under 200 characters. */
export const INBOX_DECISION_CURSOR_MAX_CHARS = 512;

/** Inbox item ids are UUIDs; anything else would reach Postgres as a failing `uuid` cast (a 500). */
const ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The sort timestamp of a row on its tab (see `InboxItemRepository.listDecisionsForUser`). */
function sortTimestampOf(row: InboxDecisionRow, status: InboxItemStatus): number {
    const item = row.item;
    const pick =
        status === 'open'
            ? item.createdAt
            : status === 'answered'
              ? (item.answeredAt ?? item.createdAt)
              : item.updatedAt;
    const date = pick instanceof Date ? pick : new Date(pick as unknown as string);
    const ms = date.getTime();
    return Number.isFinite(ms) ? ms : 0;
}

/** The cursor that continues right after `row` on the `status` tab. */
export function encodeInboxDecisionCursor(row: InboxDecisionRow, status: InboxItemStatus): string {
    const payload: CursorPayload = {
        v: 1,
        s: status,
        id: row.item.id,
        b: row.blockingRank,
        c: row.confidenceRank,
        t: sortTimestampOf(row, status),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Read a cursor back for the `status` tab. Anything malformed — or minted
 * on another tab — is a 400, never a silent restart from the top: a
 * restart would re-list rows the caller already holds and look like the
 * queue stopped moving.
 */
export function decodeInboxDecisionCursor(
    cursor: string,
    status: InboxItemStatus,
): InboxDecisionPageAfter {
    const invalid = () =>
        new BadRequestException('The decisions cursor is not valid for this view.');
    if (cursor.length === 0 || cursor.length > INBOX_DECISION_CURSOR_MAX_CHARS) throw invalid();

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        throw invalid();
    }
    if (typeof parsed !== 'object' || parsed === null) throw invalid();
    const payload = parsed as Partial<CursorPayload>;

    if (payload.v !== 1) throw invalid();
    if (!(INBOX_ITEM_STATUSES as readonly unknown[]).includes(payload.s)) throw invalid();
    if (payload.s !== status) throw invalid();
    if (typeof payload.id !== 'string' || !ID_PATTERN.test(payload.id)) throw invalid();
    if (payload.b !== 0 && payload.b !== 1) throw invalid();
    if (typeof payload.c !== 'number' || !Number.isFinite(payload.c)) throw invalid();
    if (typeof payload.t !== 'number' || !Number.isInteger(payload.t) || payload.t < 0) {
        throw invalid();
    }

    return {
        id: payload.id,
        blockingRank: payload.b,
        confidenceRank: payload.c,
        sortAt: new Date(payload.t),
    };
}
