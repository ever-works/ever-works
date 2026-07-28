import { describe, expect, it } from 'vitest';
import {
	describeHitlQuestion,
	parseHitlAnswer,
	parseHitlQuestion,
	serializeHitlAnswer,
	serializeHitlQuestion,
	validateHitlAnswer,
	HITL_QUESTION_KINDS,
	HITL_MAX_PROMPT_CHARS,
	HITL_MAX_TEXT_ANSWER_CHARS,
	type HitlAnswer,
	type HitlQuestion
} from '../hitl-question.types.js';

const questions: Record<string, HitlQuestion> = {
	confirm: {
		id: 'q-confirm',
		kind: 'confirm',
		prompt: 'Force-push the rebased branch?',
		confirmLabel: 'Force-push',
		cancelLabel: 'Leave it',
		defaultValue: false
	},
	choice: {
		id: 'q-choice',
		kind: 'choice',
		prompt: 'Which fix should I apply?',
		context: 'Both make the suite green.',
		options: [
			{ id: 'revert', label: 'Revert the commit', tone: 'warning' },
			{ id: 'patch', label: 'Patch forward', description: 'Smaller diff' }
		],
		defaultOptionId: 'patch'
	},
	multi_choice: {
		id: 'q-multi',
		kind: 'multi_choice',
		prompt: 'Which suites should I rerun?',
		options: [
			{ id: 'unit', label: 'Unit' },
			{ id: 'e2e', label: 'E2E' },
			{ id: 'lint', label: 'Lint' }
		],
		minSelected: 1,
		maxSelected: 2
	},
	text: {
		id: 'q-text',
		kind: 'text',
		prompt: 'What should the release note say?',
		placeholder: 'One line',
		multiline: true,
		maxLength: 120
	},
	approval: {
		id: 'q-approval',
		kind: 'approval',
		prompt: 'May I merge this?',
		action: 'Merge PR #42 into develop',
		risks: ['Touches billing', 'No reviewer'],
		preview: 'diff --git a/x b/x'
	}
};

describe('HITL question round-trip', () => {
	it('covers exactly the five shipped kinds', () => {
		expect([...HITL_QUESTION_KINDS].sort()).toEqual(['approval', 'choice', 'confirm', 'multi_choice', 'text']);
		expect(Object.keys(questions).sort()).toEqual([...HITL_QUESTION_KINDS].sort());
	});

	it.each(Object.entries(questions))('%s survives serialize → parse unchanged', (_kind, question) => {
		const parsed = parseHitlQuestion(serializeHitlQuestion(question));
		expect(parsed).toEqual(question);
	});

	it.each(Object.entries(questions))('%s parses from an already-decoded object too', (_kind, question) => {
		expect(parseHitlQuestion(JSON.parse(serializeHitlQuestion(question)))).toEqual(question);
	});

	it('drops unknown extra keys instead of rejecting the payload (forward compatible)', () => {
		const parsed = parseHitlQuestion({ ...questions.confirm, futureField: 'ignored' });
		expect(parsed).toEqual(questions.confirm);
	});

	it('returns null for anything it cannot read', () => {
		expect(parseHitlQuestion('not json')).toBeNull();
		expect(parseHitlQuestion(null)).toBeNull();
		expect(parseHitlQuestion([])).toBeNull();
		expect(parseHitlQuestion({ kind: 'nope', id: 'x', prompt: 'y' })).toBeNull();
		expect(parseHitlQuestion({ kind: 'confirm', prompt: 'no id' })).toBeNull();
		expect(parseHitlQuestion({ kind: 'confirm', id: 'x', prompt: '   ' })).toBeNull();
		expect(parseHitlQuestion({ kind: 'choice', id: 'x', prompt: 'y', options: [] })).toBeNull();
		expect(parseHitlQuestion({ kind: 'approval', id: 'x', prompt: 'y' })).toBeNull();
	});

	it('refuses duplicate option ids — an ambiguous answer is worse than no question', () => {
		expect(
			parseHitlQuestion({
				kind: 'choice',
				id: 'x',
				prompt: 'y',
				options: [
					{ id: 'a', label: 'A' },
					{ id: 'a', label: 'A again' }
				]
			})
		).toBeNull();
	});

	it('caps an over-long prompt instead of rejecting it', () => {
		const parsed = parseHitlQuestion({
			kind: 'confirm',
			id: 'x',
			prompt: 'p'.repeat(HITL_MAX_PROMPT_CHARS + 500)
		});
		expect(parsed?.prompt.length).toBe(HITL_MAX_PROMPT_CHARS);
	});

	it('drops a defaultOptionId that is not one of the options', () => {
		const parsed = parseHitlQuestion({ ...questions.choice, defaultOptionId: 'ghost' });
		expect(parsed).toBeTruthy();
		expect((parsed as { defaultOptionId?: string }).defaultOptionId).toBeUndefined();
	});

	it('renders a one-line description for every kind', () => {
		for (const question of Object.values(questions)) {
			expect(describeHitlQuestion(question)).toContain(question.prompt);
		}
	});
});

const answers: Record<string, HitlAnswer> = {
	confirm: { questionId: 'q-confirm', kind: 'confirm', confirmed: true },
	choice: { questionId: 'q-choice', kind: 'choice', optionId: 'patch' },
	multi_choice: { questionId: 'q-multi', kind: 'multi_choice', optionIds: ['unit', 'lint'] },
	text: { questionId: 'q-text', kind: 'text', text: 'Fixes the billing rounding bug.' },
	approval: {
		questionId: 'q-approval',
		kind: 'approval',
		decision: 'approved',
		note: 'Reviewed the diff.'
	}
};

describe('HITL answer round-trip', () => {
	it.each(Object.entries(answers))('%s survives serialize → parse unchanged', (_kind, answer) => {
		expect(parseHitlAnswer(serializeHitlAnswer(answer))).toEqual(answer);
	});

	it('returns null for a malformed answer', () => {
		expect(parseHitlAnswer('{')).toBeNull();
		expect(parseHitlAnswer({ kind: 'confirm' })).toBeNull();
		expect(parseHitlAnswer({ kind: 'confirm', questionId: 'q', confirmed: 'yes' })).toBeNull();
		expect(parseHitlAnswer({ kind: 'choice', questionId: 'q', optionId: '' })).toBeNull();
		expect(parseHitlAnswer({ kind: 'multi_choice', questionId: 'q', optionIds: ['a', 3] })).toBeNull();
		expect(parseHitlAnswer({ kind: 'approval', questionId: 'q', decision: 'maybe' })).toBeNull();
	});

	it('caps an over-long text answer', () => {
		const parsed = parseHitlAnswer({
			kind: 'text',
			questionId: 'q-text',
			text: 't'.repeat(HITL_MAX_TEXT_ANSWER_CHARS + 100)
		});
		expect((parsed as { text: string }).text.length).toBe(HITL_MAX_TEXT_ANSWER_CHARS);
	});
});

describe('validateHitlAnswer', () => {
	it.each(Object.keys(questions))('accepts the matching %s answer', (kind) => {
		expect(validateHitlAnswer(questions[kind], answers[kind])).toEqual({ valid: true });
	});

	it('rejects an answer for a different question', () => {
		const result = validateHitlAnswer(questions.confirm, {
			...answers.confirm,
			questionId: 'somebody-else'
		});
		expect(result.valid).toBe(false);
	});

	it('rejects a kind mismatch', () => {
		const result = validateHitlAnswer(questions.confirm, answers.choice);
		expect(result.valid).toBe(false);
	});

	it('rejects an option that was never offered', () => {
		const result = validateHitlAnswer(questions.choice, {
			questionId: 'q-choice',
			kind: 'choice',
			optionId: 'ghost'
		});
		expect(result).toEqual({ valid: false, error: '"ghost" is not one of the offered options' });
	});

	it('enforces min/max selection and rejects duplicates on multi_choice', () => {
		expect(
			validateHitlAnswer(questions.multi_choice, {
				questionId: 'q-multi',
				kind: 'multi_choice',
				optionIds: []
			}).valid
		).toBe(false);
		expect(
			validateHitlAnswer(questions.multi_choice, {
				questionId: 'q-multi',
				kind: 'multi_choice',
				optionIds: ['unit', 'e2e', 'lint']
			}).valid
		).toBe(false);
		expect(
			validateHitlAnswer(questions.multi_choice, {
				questionId: 'q-multi',
				kind: 'multi_choice',
				optionIds: ['unit', 'unit']
			}).valid
		).toBe(false);
	});

	it('enforces the text question maxLength', () => {
		const result = validateHitlAnswer(questions.text, {
			questionId: 'q-text',
			kind: 'text',
			text: 'x'.repeat(200)
		});
		expect(result.valid).toBe(false);
	});
});
