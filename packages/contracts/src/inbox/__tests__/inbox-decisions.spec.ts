import { describe, expect, it } from 'vitest';
import {
	INBOX_DECISION_KINDS,
	INBOX_DECISION_MAX_LIMIT,
	INBOX_DECISION_PAGE_SIZE,
	INBOX_DECISION_UNSCORED_RANK,
	INBOX_ITEM_KINDS,
	inboxDecisionNeedsReason,
	isInboxDecisionKind
} from '../inbox.types.js';

/**
 * My Decisions is the Inbox read as a decision queue. These pins are the
 * contract the API edge and the web view both lean on: which kinds are
 * decisions, the page bounds, and the one answer rule that is opt-in.
 */
describe('INBOX_DECISION_KINDS', () => {
	it('is every Inbox kind except the FYI notice', () => {
		expect([...INBOX_DECISION_KINDS]).toEqual(['question', 'approval', 'escalation']);
		expect(INBOX_ITEM_KINDS.filter((kind) => !INBOX_DECISION_KINDS.includes(kind))).toEqual(['notice']);
	});

	it('narrows untrusted values', () => {
		expect(isInboxDecisionKind('approval')).toBe(true);
		expect(isInboxDecisionKind('notice')).toBe(false);
		expect(isInboxDecisionKind('APPROVAL')).toBe(false);
		expect(isInboxDecisionKind(undefined)).toBe(false);
		expect(isInboxDecisionKind(3)).toBe(false);
	});

	it('pins the page bounds and the unscored rank', () => {
		expect(INBOX_DECISION_PAGE_SIZE).toBe(25);
		expect(INBOX_DECISION_MAX_LIMIT).toBe(100);
		expect(INBOX_DECISION_UNSCORED_RANK).toBeGreaterThan(0.4);
		expect(INBOX_DECISION_UNSCORED_RANK).toBeLessThan(0.6);
	});
});

describe('inboxDecisionNeedsReason', () => {
	const approval = {
		kind: 'approval' as const,
		options: [
			{ id: 'approve', label: 'Approve' },
			{ id: 'reject', label: 'Reject' }
		]
	};

	it('requires a reason to reject an approval, never to approve one', () => {
		expect(inboxDecisionNeedsReason(approval, 'reject')).toBe(true);
		expect(inboxDecisionNeedsReason(approval, 'approve')).toBe(false);
	});

	it('requires a reason when a question is answered against its recommendation', () => {
		const question = {
			kind: 'question' as const,
			options: [
				{ id: 'pg', label: 'Postgres', recommended: true },
				{ id: 'sqlite', label: 'SQLite' }
			]
		};
		expect(inboxDecisionNeedsReason(question, 'sqlite')).toBe(true);
		expect(inboxDecisionNeedsReason(question, 'pg')).toBe(false);
	});

	it('does not require a reason when the question recommends nothing', () => {
		const question = {
			kind: 'question' as const,
			options: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' }
			]
		};
		expect(inboxDecisionNeedsReason(question, 'b')).toBe(false);
	});

	it('does not require a reason for free text, escalations or notices', () => {
		expect(inboxDecisionNeedsReason(approval, null)).toBe(false);
		expect(inboxDecisionNeedsReason(approval, undefined)).toBe(false);
		expect(inboxDecisionNeedsReason({ kind: 'escalation', options: null }, 'reject')).toBe(false);
		expect(inboxDecisionNeedsReason({ kind: 'notice' }, 'reject')).toBe(false);
		expect(inboxDecisionNeedsReason({ kind: 'question', options: null }, 'x')).toBe(false);
	});
});
