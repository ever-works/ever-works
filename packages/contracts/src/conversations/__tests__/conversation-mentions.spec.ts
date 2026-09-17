import { describe, expect, it } from 'vitest';

import {
	MAX_MENTIONS_PER_MESSAGE,
	findConversationDocumentReferences,
	parseConversationMentions,
	type ConversationMentionCandidateSource
} from '../index.js';

/**
 * The composer highlights a mention with this function and the server decides
 * who a message reaches with the same one. These cases pin the rule both sides
 * rely on: a highlight must always mean the mention lands.
 */
const nova: ConversationMentionCandidateSource = { type: 'agent', id: 'a-nova', slug: 'nova', name: 'Nova' };
const novaPrime: ConversationMentionCandidateSource = {
	type: 'agent',
	id: 'a-prime',
	slug: 'nova-prime',
	name: 'Nova Prime'
};
const orion: ConversationMentionCandidateSource = { type: 'agent', id: 'a-orion', slug: 'orion', name: 'Orion' };

describe('parseConversationMentions', () => {
	it('matches a full display name case-insensitively and reports its span', () => {
		const parsed = parseConversationMentions('Ask @nova to check', [nova]);
		expect(parsed.agentIds).toEqual(['a-nova']);
		expect(parsed.spans).toEqual([{ start: 4, length: 5, type: 'agent', id: 'a-nova' }]);
	});

	it('never matches a prefix of a name', () => {
		const parsed = parseConversationMentions('Ask @Nov to check', [nova]);
		expect(parsed.spans).toEqual([]);
		expect(parsed.agentVisibleBody).toBe('Ask to check');
	});

	it('prefers the longest name, so a two-word name highlights as one unit', () => {
		const parsed = parseConversationMentions('@Nova Prime, then @Nova', [nova, novaPrime]);
		expect(parsed.spans.map((span) => [span.start, span.length, span.id])).toEqual([
			[0, 11, 'a-prime'],
			[18, 5, 'a-nova']
		]);
	});

	it('leaves document references and email addresses alone', () => {
		const parsed = parseConversationMentions('see @kb:brand/voice or mail me@nova.dev', [nova]);
		expect(parsed.spans).toEqual([]);
		expect(parsed.agentVisibleBody).toBe('see @kb:brand/voice or mail me@nova.dev');
	});

	it('keeps mentions past the cap as plain text and never highlights them', () => {
		const many = Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 1 }, (_, index) => ({
			type: 'agent' as const,
			id: `a-${index}`,
			slug: `agent-${index}`,
			name: `Agent${index}`
		}));
		const body = many.map((candidate) => `@${candidate.name}`).join(' ');
		const parsed = parseConversationMentions(body, [...many, orion]);
		expect(parsed.mentions).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
		expect(parsed.spans).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
		expect(parsed.overLimit).toBe(1);
	});
});

describe('findConversationDocumentReferences', () => {
	it('finds every `@kb:` reference with its position', () => {
		expect(findConversationDocumentReferences('read @kb:brand/voice and @kb:faq')).toEqual([
			{ start: 5, length: 15, slug: 'brand/voice' },
			{ start: 25, length: 7, slug: 'faq' }
		]);
	});

	it('ignores a reference glued to a word', () => {
		expect(findConversationDocumentReferences('abc@kb:faq')).toEqual([]);
	});
});
