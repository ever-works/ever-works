import { BadRequestException } from '@nestjs/common';
import {
    decodeInboxDecisionCursor,
    encodeInboxDecisionCursor,
    INBOX_DECISION_CURSOR_MAX_CHARS,
} from '../inbox-decision-cursor';
import type { InboxDecisionRow } from '../../database/repositories/inbox-item.repository';
import type { InboxItem } from '../../entities/inbox-item.entity';

/**
 * My Decisions — the "Load more" cursor. It carries the position of the
 * last row a caller holds, so what matters is that it round-trips that
 * position exactly for each tab, and that anything else is a 400 rather
 * than a silent restart from the top.
 */

const ID = '3f2b6c1e-4d5a-4b7c-9e8f-0a1b2c3d4e5f';

function row(overrides: Partial<InboxItem> = {}, ranks: Partial<InboxDecisionRow> = {}) {
    return {
        item: {
            id: ID,
            createdAt: new Date('2026-08-01T10:00:00.123Z'),
            updatedAt: new Date('2026-08-03T10:00:00.456Z'),
            answeredAt: new Date('2026-08-02T10:00:00.789Z'),
            ...overrides,
        } as InboxItem,
        blockingRank: 1,
        confidenceRank: 0.7300000000000001,
        ...ranks,
    } as InboxDecisionRow;
}

function encodeRaw(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('inbox decision cursor', () => {
    it('round-trips the open-tab position, confidence to the last bit', () => {
        const cursor = encodeInboxDecisionCursor(row(), 'open');

        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(cursor.length).toBeLessThanOrEqual(INBOX_DECISION_CURSOR_MAX_CHARS);
        expect(decodeInboxDecisionCursor(cursor, 'open')).toEqual({
            id: ID,
            blockingRank: 1,
            confidenceRank: 0.7300000000000001,
            sortAt: new Date('2026-08-01T10:00:00.123Z'),
        });
    });

    it('carries the sort timestamp of each tab', () => {
        expect(
            decodeInboxDecisionCursor(encodeInboxDecisionCursor(row(), 'answered'), 'answered')
                .sortAt,
        ).toEqual(new Date('2026-08-02T10:00:00.789Z'));
        expect(
            decodeInboxDecisionCursor(encodeInboxDecisionCursor(row(), 'archived'), 'archived')
                .sortAt,
        ).toEqual(new Date('2026-08-03T10:00:00.456Z'));
        // An answered row read back without its timestamp falls back to createdAt.
        expect(
            decodeInboxDecisionCursor(
                encodeInboxDecisionCursor(row({ answeredAt: null }), 'answered'),
                'answered',
            ).sortAt,
        ).toEqual(new Date('2026-08-01T10:00:00.123Z'));
    });

    it('accepts a driver string date (SQLite paths)', () => {
        const cursor = encodeInboxDecisionCursor(
            row({ createdAt: '2026-08-01T10:00:00.123Z' as unknown as Date }),
            'open',
        );
        expect(decodeInboxDecisionCursor(cursor, 'open').sortAt).toEqual(
            new Date('2026-08-01T10:00:00.123Z'),
        );
    });

    it('refuses a cursor minted on another tab', () => {
        const cursor = encodeInboxDecisionCursor(row(), 'open');
        expect(() => decodeInboxDecisionCursor(cursor, 'answered')).toThrow(BadRequestException);
    });

    it.each([
        ['empty', ''],
        ['too long', 'x'.repeat(INBOX_DECISION_CURSOR_MAX_CHARS + 1)],
        ['not base64 JSON', 'bm90IGpzb24'],
        ['a JSON scalar', encodeRaw(42)],
        ['an unknown version', encodeRaw({ v: 2, s: 'open', id: ID, b: 0, c: 0.5, t: 1 })],
        ['an unknown tab', encodeRaw({ v: 1, s: 'deleted', id: ID, b: 0, c: 0.5, t: 1 })],
        [
            'an id with SQL in it',
            encodeRaw({ v: 1, s: 'open', id: "x' OR 1=1", b: 0, c: 0.5, t: 1 }),
        ],
        ['an id that is not a UUID', encodeRaw({ v: 1, s: 'open', id: 'abc', b: 0, c: 0.5, t: 1 })],
        ['a blocking rank of 2', encodeRaw({ v: 1, s: 'open', id: ID, b: 2, c: 0.5, t: 1 })],
        ['a non-numeric confidence', encodeRaw({ v: 1, s: 'open', id: ID, b: 0, c: '0.5', t: 1 })],
        ['a negative timestamp', encodeRaw({ v: 1, s: 'open', id: ID, b: 0, c: 0.5, t: -1 })],
        ['a fractional timestamp', encodeRaw({ v: 1, s: 'open', id: ID, b: 0, c: 0.5, t: 1.5 })],
    ])('refuses %s with a 400', (_label, cursor) => {
        expect(() => decodeInboxDecisionCursor(cursor, 'open')).toThrow(BadRequestException);
    });
});
