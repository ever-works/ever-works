import { describe, expect, it } from 'vitest';
import type { FleetSessionAttention } from '@ever-works/contracts';
import { keysForAnswer } from '../answer-typist';
import { SessionRulesEngine } from '../rules-engine';
import { CODEX_RULES } from '../rules/session-rules';

/**
 * The screen rules and the answer keys (FL-05 spec FR-28, FR-31, FR-33 …
 * FR-36, S9; ACC-FL05-20). Transcripts are captured-screen shapes, trimmed.
 */

const CODEX_APPROVAL = [
	'› Run the tests and fix what fails',
	'',
	'  Would you like to run the following command?',
	'',
	'  $ rm -rf dist',
	'',
	'› 1. Yes, proceed (y)',
	"  2. Yes, and don't ask again for this command (a)",
	'  3. No, and tell Codex what to do differently (esc)'
].join('\n');

const CLAUDE_TRUST = ['Do you trust the files in this folder?', '', '/home/dana/code/api', '', '❯ 1. Yes, proceed', '  2. No, exit'].join(
	'\n'
);

const CLAUDE_WORKING = ['✻ Running the migration tests… (12s · esc to interrupt)'].join('\n');

describe('SessionRulesEngine', () => {
	it('raises a Codex approval as needs_you (permission) with the keys that answer it (S9)', () => {
		const engine = new SessionRulesEngine();
		// quietMs debounce: the first sight does not fire, a second after does.
		expect(engine.evaluate('s1', 'codex', { screen: CODEX_APPROVAL, title: '' }, 1_000)).toBeNull();
		const match = engine.evaluate('s1', 'codex', { screen: CODEX_APPROVAL, title: '' }, 2_100);
		expect(match?.ruleId).toBe('codex.exec-approval');
		expect(match?.evidence).toMatchObject({ source: 'rules', event: 'permission' });
		expect(match?.evidence.prompt).toContain('Would you like to run the following command?');
		expect(match?.keys).toEqual({ yes: 'y', always: 'a', no: '\u001b' });
	});

	it('reads a trust prompt and a running turn', () => {
		const engine = new SessionRulesEngine();
		expect(engine.evaluate('s2', 'claude-code', { screen: CLAUDE_TRUST, title: '' }, 0)?.evidence.event).toBe('question');
		expect(engine.evaluate('s3', 'claude-code', { screen: CLAUDE_WORKING, title: '' }, 0)?.evidence.event).toBe('working');
	});

	it('has no rules for a shell, and no rule can raise done', () => {
		const engine = new SessionRulesEngine();
		expect(engine.hasRules('shell')).toBe(false);
		for (const rule of CODEX_RULES.rules) expect(rule.then.state).not.toBe('done');
	});

	it('refuses an invalid rules file at start, naming the rule', () => {
		expect(
			() =>
				new SessionRulesEngine([
					{ version: 1, provider: 'codex', rules: [{ ...CODEX_RULES.rules[0], why: '' }] }
				])
		).toThrow(/codex\.exec-approval/);
	});
});

describe('keysForAnswer', () => {
	const permission: FleetSessionAttention = {
		key: 'fleet-session:s1:permission:1',
		reason: 'permission',
		prompt: 'Allow Bash(ls)?',
		options: [
			{ id: '1', label: 'Allow', primary: true },
			{ id: '2', label: 'Deny', deny: true }
		],
		raisedAt: '2026-10-21T10:00:00Z',
		acknowledgedAt: null
	};

	it('types Claude Code digits, Esc for deny', () => {
		expect(keysForAnswer({ provider: 'claude-code', attention: permission, answer: { optionId: '1' } })).toEqual({
			ok: true,
			keys: '1'
		});
		expect(keysForAnswer({ provider: 'claude-code', attention: permission, answer: { optionId: '2' } })).toEqual({
			ok: true,
			keys: '\u001b'
		});
	});

	it('types a rule’s keys and refuses text a prompt does not take', () => {
		expect(
			keysForAnswer({
				provider: 'codex',
				attention: { ...permission, options: [{ id: 'yes', label: 'Yes' }] },
				answer: { optionId: 'yes' },
				ruleKeys: { yes: 'y' }
			})
		).toEqual({ ok: true, keys: 'y' });
		expect(keysForAnswer({ provider: 'claude-code', attention: permission, answer: { text: 'x' } }).ok).toBe(false);
	});

	it('types a question’s free text through its "other" entry', () => {
		const question: FleetSessionAttention = {
			...permission,
			reason: 'question',
			allowsText: true,
			options: [
				{ id: '1', label: 'eu-west' },
				{ id: '2', label: 'us-east' }
			]
		};
		expect(keysForAnswer({ provider: 'claude-code', attention: question, answer: { text: 'ap-south' } })).toEqual({
			ok: true,
			keys: '3ap-south\r'
		});
		expect(keysForAnswer({ provider: 'claude-code', attention: question, answer: { text: 'a\u0003b' } }).ok).toBe(false);
	});
});
