import { describe, expect, it } from 'vitest';
import {
	AGENT_PAIR_DAILY_MESSAGE_CEILING,
	AGENT_PAIR_STREAK_CEILING,
	CONVERSATION_KINDS,
	CONVERSATION_LIST_DEFAULT_LIMIT,
	CONVERSATION_LIST_MAX_LIMIT,
	CONVERSATION_NAME_MAX,
	CONVERSATION_REACH_OUTCOMES,
	MAX_ATTACHMENTS_PER_MESSAGE,
	MAX_BROADCAST_AGENTS,
	MAX_CONVERSATION_BODY_BYTES,
	MAX_DISPATCH_PER_MESSAGE,
	MAX_GROUP_AGENTS,
	MAX_MENTION_CANDIDATES,
	MAX_MENTIONS_PER_MESSAGE,
	PROMOTION_CARRY_DAYS,
	PROMOTION_CARRY_MESSAGES,
	conversationBodyBytes,
	isConversationContextType,
	isConversationFailureCode,
	isConversationKind,
	isConversationReachOutcome,
	isPersonallyDeletableConversationKind
} from '../conversation.types.js';

describe('conversation limits', () => {
	it('pins every number an owner can run into', () => {
		expect(MAX_CONVERSATION_BODY_BYTES).toBe(16 * 1024);
		expect(MAX_MENTIONS_PER_MESSAGE).toBe(10);
		expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(10);
		expect(MAX_GROUP_AGENTS).toBe(8);
		expect(MAX_DISPATCH_PER_MESSAGE).toBe(8);
		expect(MAX_BROADCAST_AGENTS).toBe(200);
		expect(PROMOTION_CARRY_MESSAGES).toBe(20);
		expect(PROMOTION_CARRY_DAYS).toBe(7);
		expect(AGENT_PAIR_STREAK_CEILING).toBe(20);
		expect(AGENT_PAIR_DAILY_MESSAGE_CEILING).toBe(200);
		expect(CONVERSATION_NAME_MAX).toBe(200);
		expect(MAX_MENTION_CANDIDATES).toBe(8);
		expect(CONVERSATION_LIST_DEFAULT_LIMIT).toBe(50);
		expect(CONVERSATION_LIST_MAX_LIMIT).toBe(200);
	});
});

describe('conversation guards', () => {
	it('accepts every declared kind and nothing else', () => {
		for (const kind of CONVERSATION_KINDS) expect(isConversationKind(kind)).toBe(true);
		expect(isConversationKind('thread')).toBe(false);
		expect(isConversationKind(undefined)).toBe(false);
		expect(isConversationKind(3)).toBe(false);
	});

	it('orders reach outcomes delivered → queued → skipped → refused', () => {
		expect([...CONVERSATION_REACH_OUTCOMES]).toEqual(['delivered', 'queued', 'skipped', 'refused']);
		expect(isConversationReachOutcome('queued')).toBe(true);
		expect(isConversationReachOutcome('lost')).toBe(false);
	});

	it('recognises context types and failure codes', () => {
		expect(isConversationContextType('mission')).toBe(true);
		expect(isConversationContextType('workspace')).toBe(false);
		expect(isConversationFailureCode('rate_limited')).toBe(true);
		expect(isConversationFailureCode('capacity_limited')).toBe(true);
		expect(isConversationFailureCode('budget_exceeded')).toBe(true);
		expect(isConversationFailureCode('500')).toBe(false);
	});

	it('never lets "delete all" reach a shared Conversation', () => {
		expect(isPersonallyDeletableConversationKind('direct')).toBe(true);
		expect(isPersonallyDeletableConversationKind('group')).toBe(true);
		expect(isPersonallyDeletableConversationKind('organization_channel')).toBe(false);
		expect(isPersonallyDeletableConversationKind('agent_pair')).toBe(false);
	});
});

describe('conversationBodyBytes', () => {
	it('measures UTF-8 bytes, not characters', () => {
		expect(conversationBodyBytes('abc')).toBe(3);
		// Each of these is one character and more than one byte.
		expect(conversationBodyBytes('é')).toBe(2);
		expect(conversationBodyBytes('✓')).toBe(3);
	});

	it('puts the cap exactly at 16 KB', () => {
		expect(conversationBodyBytes('a'.repeat(MAX_CONVERSATION_BODY_BYTES))).toBe(MAX_CONVERSATION_BODY_BYTES);
		expect(conversationBodyBytes('é'.repeat(MAX_CONVERSATION_BODY_BYTES / 2 + 1))).toBeGreaterThan(
			MAX_CONVERSATION_BODY_BYTES
		);
	});
});
