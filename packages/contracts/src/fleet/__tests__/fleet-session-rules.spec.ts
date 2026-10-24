import { describe, expect, it } from 'vitest';

import { validateFleetSessionRulesFile } from '../fleet-session-rules.types.js';

/** The rules-file guard (FL-05 FR-33 … FR-36; ACC-FL05-20). */

const rule = {
	id: 'codex.exec-approval',
	when: { region: 'screen', match: 'would you like to run the following command\?', flags: 'i' },
	then: {
		state: 'needs_you',
		reason: 'permission',
		options: [
			{ id: 'yes', label: 'Yes', keys: 'y', primary: true },
			{ id: 'no', label: 'No', keys: '\u001b', deny: true }
		]
	},
	why: 'Codex asks before running a command and its notify hook says nothing until the turn ends.'
};

describe('validateFleetSessionRulesFile', () => {
	it('accepts a well-formed file', () => {
		expect(validateFleetSessionRulesFile({ version: 1, provider: 'codex', rules: [rule] }).ok).toBe(true);
	});

	it('refuses a rule without a why, naming it', () => {
		const result = validateFleetSessionRulesFile({ version: 1, provider: 'codex', rules: [{ ...rule, why: '' }] });
		expect(result).toEqual({ ok: false, ruleId: 'codex.exec-approval', problem: 'every rule says why it exists' });
	});

	it('refuses a rule that would raise done', () => {
		const result = validateFleetSessionRulesFile({
			version: 1,
			provider: 'codex',
			rules: [{ ...rule, then: { state: 'done' } }]
		});
		expect(result.ok).toBe(false);
	});

	it('refuses a pattern that does not compile, and any flag but i', () => {
		expect(
			validateFleetSessionRulesFile({
				version: 1,
				provider: 'codex',
				rules: [{ ...rule, when: { region: 'screen', match: '(' } }]
			}).ok
		).toBe(false);
		expect(
			validateFleetSessionRulesFile({
				version: 1,
				provider: 'codex',
				rules: [{ ...rule, when: { region: 'screen', match: 'x', flags: 'g' } }]
			}).ok
		).toBe(false);
	});
});
