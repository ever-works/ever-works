import { describe, expect, it } from 'vitest';
import {
    INBOX_DECISION_KINDS as CONTRACT_DECISION_KINDS,
    INBOX_DECISION_PAGE_SIZE as CONTRACT_DECISION_PAGE_SIZE,
    INBOX_DECISION_QUIET_WINDOW_DAYS as CONTRACT_QUIET_WINDOW_DAYS,
    INBOX_ITEM_KINDS,
    INBOX_ITEM_SOURCE_TYPES,
    INBOX_ITEM_STATUSES,
    INBOX_MAX_REPLY_CHARS as CONTRACT_MAX_REPLY_CHARS,
    inboxDecisionNeedsReason,
} from '@ever-works/contracts';
import {
    INBOX_DECISION_KINDS,
    INBOX_DECISION_PAGE_SIZE,
    INBOX_DECISION_QUIET_WINDOW_DAYS,
    INBOX_MAX_REPLY_CHARS,
    INBOX_POLL_INTERVAL_MS,
    buildDecisionsHref,
    decisionConfidencePercent,
    decisionEmptyState,
    decisionNeedsReason,
    decisionRestartKey,
    hasDecisionFilters,
    isAwaitingReply,
    isFleetQuestion,
    parseDecisionFilters,
    type InboxItem,
    type InboxItemKind,
    type InboxItemOption,
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
        // `fleet-run` (self-build slice Q) is appended LAST — the contracts
        // list is ordered by the release each source shipped in.
        expect(sourceTypes).toEqual([
            'agent-run',
            'escalation',
            'proposal',
            'system',
            'work',
            'fleet-run',
        ]);
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

    it('flags fleet-run questions by source type alone, whatever sourceMeta says', () => {
        // Slice Q: the source type is the signal; `sourceMeta` is decoration
        // that an older API omits and a degraded producer may leave null.
        expect(isFleetQuestion(item({ sourceType: 'fleet-run' }))).toBe(true);
        expect(isFleetQuestion(item({ sourceType: 'fleet-run', sourceMeta: null }))).toBe(true);
        expect(
            isFleetQuestion(
                item({
                    sourceType: 'fleet-run',
                    sourceMeta: { nodeName: 'everdesk2', branch: 'task/tsk-1-fix' },
                }),
            ),
        ).toBe(true);
        expect(isFleetQuestion(item({}))).toBe(false);
        expect(
            isFleetQuestion(item({ sourceType: 'agent-run', sourceMeta: { nodeName: 'x' } })),
        ).toBe(false);
        expect(isFleetQuestion(item({ sourceType: 'system', kind: 'notice' }))).toBe(false);
    });
});

describe('My Decisions — mirrors the contract', () => {
    it('mirrors the decision kinds, the page size and the quiet window', () => {
        expect([...INBOX_DECISION_KINDS]).toEqual([...CONTRACT_DECISION_KINDS]);
        expect(INBOX_DECISION_PAGE_SIZE).toBe(CONTRACT_DECISION_PAGE_SIZE);
        expect(INBOX_DECISION_QUIET_WINDOW_DAYS).toBe(CONTRACT_QUIET_WINDOW_DAYS);
    });

    it('applies the same reason rule the API enforces', () => {
        const approval: InboxItemOption[] = [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
        ];
        const question: InboxItemOption[] = [
            { id: 'pro', label: 'Pro', recommended: true },
            { id: 'standard', label: 'Standard' },
        ];
        const cases: Array<[InboxItemKind, InboxItemOption[] | null, string | null]> = [
            ['approval', approval, 'reject'],
            ['approval', approval, 'approve'],
            ['question', question, 'standard'],
            ['question', question, 'pro'],
            ['question', null, 'x'],
            ['escalation', null, null],
            ['notice', null, 'reject'],
        ];
        for (const [kind, options, optionId] of cases) {
            expect(decisionNeedsReason({ kind, options }, optionId)).toBe(
                inboxDecisionNeedsReason({ kind, options }, optionId),
            );
        }
        expect(decisionNeedsReason({ kind: 'approval', options: approval }, 'reject')).toBe(true);
        expect(decisionNeedsReason({ kind: 'question', options: question }, 'pro')).toBe(false);
    });
});

describe('parseDecisionFilters / buildDecisionsHref', () => {
    const uuid = '3f2b6c1e-4d5a-4b7c-9e8f-0a1b2c3d4e5f';

    it('defaults to the open tab with no filters', () => {
        expect(parseDecisionFilters({})).toEqual({ tab: 'open' });
        expect(hasDecisionFilters(parseDecisionFilters({}))).toBe(false);
    });

    it('keeps valid filters and drops malformed ones instead of forwarding them', () => {
        expect(
            parseDecisionFilters({
                tab: 'archived',
                kind: 'approval',
                agentId: uuid,
                taskId: 'not-a-uuid',
                missionId: [uuid, 'second'],
                q: '  budget  ',
            }),
        ).toEqual({
            tab: 'archived',
            kind: 'approval',
            agentId: uuid,
            missionId: uuid,
            q: 'budget',
        });
        expect(parseDecisionFilters({ tab: 'deleted', kind: 'notice' })).toEqual({ tab: 'open' });
    });

    it('round-trips through the URL so a filtered queue is linkable', () => {
        const filters = parseDecisionFilters({
            tab: 'answered',
            kind: 'escalation',
            taskId: uuid,
            q: 'a b',
        });
        const href = buildDecisionsHref(filters, 'item-1');
        expect(href).toBe(
            `/inbox?view=decisions&tab=answered&kind=escalation&taskId=${uuid}&q=a+b&id=item-1`,
        );
        const params = Object.fromEntries(new URL(href, 'http://x').searchParams.entries());
        expect(parseDecisionFilters(params)).toEqual(filters);
        expect(buildDecisionsHref({ tab: 'open' })).toBe('/inbox?view=decisions');
    });
});

describe('decision labels and states', () => {
    it('shows confidence as a whole percent and an unscored decision as null', () => {
        expect(decisionConfidencePercent(0.824)).toBe(82);
        expect(decisionConfidencePercent(1.4)).toBe(100);
        expect(decisionConfidencePercent(0)).toBe(0);
        expect(decisionConfidencePercent(null)).toBeNull();
        expect(decisionConfidencePercent(Number.NaN)).toBeNull();
    });

    it('picks first-run, quiet or clear for an empty open queue', () => {
        const now = new Date('2026-09-13T00:00:00.000Z');
        expect(decisionEmptyState(null, now)).toEqual({ kind: 'first-run' });
        expect(decisionEmptyState('garbage', now)).toEqual({ kind: 'first-run' });
        expect(decisionEmptyState('2026-08-30T00:00:00.000Z', now)).toEqual({
            kind: 'quiet',
            days: 14,
        });
        expect(decisionEmptyState('2026-08-31T00:00:00.000Z', now)).toEqual({ kind: 'clear' });
    });

    it('says what happened to the work, falling back to the routing verdict on an older API', () => {
        expect(decisionRestartKey({ routed: 'escalation-resolved', restart: 'queued' })).toBe(
            'queued',
        );
        expect(decisionRestartKey({ routed: 'already-decided', restart: 'none' })).toBe(
            'alreadyDecided',
        );
        expect(decisionRestartKey({ routed: 'steered' })).toBe('injected');
        expect(decisionRestartKey({ routed: 'resumed' })).toBe('resumed');
        expect(decisionRestartKey({ routed: 'approved' })).toBe('none');
    });
});
