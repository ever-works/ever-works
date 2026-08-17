import { describe, expect, it } from 'vitest';
import {
    INBOX_ITEM_KINDS,
    INBOX_ITEM_SOURCE_TYPES,
    INBOX_ITEM_STATUSES,
    INBOX_MAX_REPLY_CHARS as CONTRACT_MAX_REPLY_CHARS,
} from '@ever-works/contracts';
import {
    INBOX_MAX_REPLY_CHARS,
    INBOX_POLL_INTERVAL_MS,
    isAwaitingReply,
    type InboxItem,
    type InboxItemKind,
    type InboxItemSourceType,
    type InboxItemStatus,
} from './inbox.shared';

/**
 * `inbox.shared.ts` re-declares a handful of contract values so
 * `'use client'` components need no runtime contracts import. That copy
 * is only safe while it MATCHES — a drifted reply cap means the
 * textarea silently truncates at a length the API would have accepted,
 * or lets through one it 400s on.
 */
describe('inbox.shared — contract parity', () => {
    it('pins the reply cap to the value the API enforces', () => {
        expect(INBOX_MAX_REPLY_CHARS).toBe(CONTRACT_MAX_REPLY_CHARS);
    });

    it('covers exactly the contract kinds / statuses / source types', () => {
        // A compile error here means the union drifted; the runtime
        // assertion catches a value added to only one side.
        const kinds: InboxItemKind[] = [...INBOX_ITEM_KINDS];
        const statuses: InboxItemStatus[] = [...INBOX_ITEM_STATUSES];
        const sourceTypes: InboxItemSourceType[] = [...INBOX_ITEM_SOURCE_TYPES];
        expect(kinds).toEqual(['question', 'approval', 'escalation', 'notice']);
        expect(statuses).toEqual(['open', 'answered', 'archived']);
        expect(sourceTypes).toEqual(['agent-run', 'escalation', 'proposal', 'system', 'work']);
    });

    it('polls at the notification bell cadence', () => {
        expect(INBOX_POLL_INTERVAL_MS).toBe(30_000);
    });
});

describe('isAwaitingReply', () => {
    function item(overrides: Partial<InboxItem>): InboxItem {
        return {
            id: 'i1',
            kind: 'question',
            title: 't',
            body: 'b',
            options: null,
            sourceType: 'agent-run',
            agentId: null,
            agentRunId: null,
            taskId: null,
            workId: null,
            escalationId: null,
            proposalId: null,
            status: 'open',
            unread: true,
            answeredAt: null,
            answerText: null,
            answerOptionId: null,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            ...overrides,
        };
    }

    it('is true only for an OPEN question — the only kind that parks a run', () => {
        expect(isAwaitingReply(item({}))).toBe(true);
        expect(isAwaitingReply(item({ status: 'answered' }))).toBe(false);
        expect(isAwaitingReply(item({ status: 'archived' }))).toBe(false);
        expect(isAwaitingReply(item({ kind: 'approval' }))).toBe(false);
        expect(isAwaitingReply(item({ kind: 'escalation' }))).toBe(false);
        expect(isAwaitingReply(item({ kind: 'notice' }))).toBe(false);
    });
});
