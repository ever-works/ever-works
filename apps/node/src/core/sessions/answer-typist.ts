import type { FleetSessionAnswerParams, FleetSessionAttention, FleetSessionProvider } from '@ever-works/contracts';

/**
 * Session attention (FL-05 P2, plan §6.4, spec FR-28, FR-31, FR-35) — the
 * keys that answer a prompt the way its CLI expects, typed by the node.
 *
 * | Prompt                               | an option                  | deny / cancel | free text                     |
 * | ------------------------------------ | -------------------------- | ------------- | ----------------------------- |
 * | Claude Code permission (hook)        | its digit                  | Esc           | —                             |
 * | Claude Code question (hook)          | its digit                  | —             | "other"'s digit, text, Enter  |
 * | raised by a screen rule              | the rule's keys            | the rule's    | text, Enter (when the rule says) |
 *
 * Claude Code's numbered dialogs choose on the digit (no Enter); Esc is its
 * "no, tell Claude what to do differently". The platform never sends keys —
 * only an option id or a text — so a compromised report cannot make the node
 * type anything but what the CLI's own options are.
 */

export type TypistResult = { ok: true; keys: string } | { ok: false; hint: string };

/** Control characters a free-text answer may not carry (the answer is typed into a terminal). */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function keysForAnswer(input: {
	provider: FleetSessionProvider;
	attention: FleetSessionAttention;
	answer: FleetSessionAnswerParams['answer'];
	/** optionId → keys, when a screen rule raised the prompt. */
	ruleKeys?: Readonly<Record<string, string>> | null;
}): TypistResult {
	const { attention, answer } = input;
	if (answer.text !== undefined) {
		if (!attention.allowsText && !input.ruleKeys) return { ok: false, hint: 'this prompt takes one of its options' };
		const flat = answer.text.replace(/\r?\n/g, ' ');
		if (UNSAFE_TEXT.test(flat)) return { ok: false, hint: 'an answer cannot carry control characters' };
		if (input.ruleKeys) return { ok: true, keys: `${flat}\r` };
		// Claude Code's question tool: the "other" entry follows the options.
		return { ok: true, keys: `${attention.options.length + 1}${flat}\r` };
	}
	const optionId = answer.optionId;
	const option = attention.options.find((candidate) => candidate.id === optionId);
	if (!option || !optionId) return { ok: false, hint: 'not one of the options' };
	if (input.ruleKeys) {
		const keys = input.ruleKeys[optionId];
		return keys ? { ok: true, keys } : { ok: false, hint: 'this option cannot be typed' };
	}
	if (input.provider === 'claude-code') {
		if (option.deny && attention.reason === 'permission') return { ok: true, keys: '\u001b' };
		if (/^[1-9]$/.test(optionId)) return { ok: true, keys: optionId };
		return { ok: false, hint: 'this option cannot be typed' };
	}
	return { ok: false, hint: 'this prompt is answered in the terminal' };
}
