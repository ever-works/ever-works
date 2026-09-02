import { describe, expect, it } from 'vitest';

import {
	DEFAULT_FLEET_AGENT_EXECUTION_MODE,
	DEFAULT_FLEET_AGENT_EXECUTION_PERMISSION_MODE,
	DEFAULT_FLEET_AGENT_EXECUTION_PROVIDER,
	FLEET_AGENT_EXECUTION_DEFAULT_TIMEOUT_SEC,
	FLEET_AGENT_EXECUTION_MAX_BUDGET_USD,
	FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES,
	FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC,
	FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC,
	FLEET_AGENT_EXECUTION_MODES,
	FLEET_AGENT_EXECUTION_PROVIDERS,
	FleetAgentExecutionError,
	isFleetAgentExecutionMode,
	isFleetAgentExecutionProvider,
	normalizeFleetAgentModelExecution
} from '../fleet-jobs.types';

/**
 * Agent execution v2 — the model-CLI execution block.
 *
 * Every field except `instructions` ends up on a command line the node
 * runs through a shell, so the normalizer must REFUSE anything that is
 * not an enum, a bounded number or an opaque id. A coerced value would
 * be a verdict the operator never asked for.
 */
describe('fleet agent execution contract', () => {
	it('pins the vocabularies and defaults', () => {
		expect(FLEET_AGENT_EXECUTION_PROVIDERS).toEqual(['claude-code', 'codex']);
		expect(FLEET_AGENT_EXECUTION_MODES).toEqual(['command', 'model-cli']);
		// `command` stays the default so every existing install keeps its
		// exact pre-v2 behaviour until an operator opts into model-cli.
		expect(DEFAULT_FLEET_AGENT_EXECUTION_MODE).toBe('command');
		expect(DEFAULT_FLEET_AGENT_EXECUTION_PROVIDER).toBe('claude-code');
		expect(DEFAULT_FLEET_AGENT_EXECUTION_PERMISSION_MODE).toBe('acceptEdits');
		expect(FLEET_AGENT_EXECUTION_DEFAULT_TIMEOUT_SEC).toBe(1200);
		expect(FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC).toBe(60);
		expect(FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC).toBe(1800);
		expect(FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES).toBe(160 * 1024);
		expect(FLEET_AGENT_EXECUTION_MAX_BUDGET_USD).toBe(500);
	});

	it('type guards accept only the vocabulary', () => {
		expect(isFleetAgentExecutionProvider('claude-code')).toBe(true);
		expect(isFleetAgentExecutionProvider('gemini')).toBe(false);
		expect(isFleetAgentExecutionProvider(undefined)).toBe(false);
		expect(isFleetAgentExecutionMode('model-cli')).toBe(true);
		expect(isFleetAgentExecutionMode('shell')).toBe(false);
	});

	describe('normalizeFleetAgentModelExecution', () => {
		it('accepts a minimal block and keeps the instructions verbatim', () => {
			const out = normalizeFleetAgentModelExecution({
				provider: 'claude-code',
				instructions: '  Fix the failing test in apps/api.\n'
			});
			expect(out).toEqual({ provider: 'claude-code', instructions: '  Fix the failing test in apps/api.\n' });
		});

		it('carries every optional field through when valid', () => {
			const out = normalizeFleetAgentModelExecution({
				provider: 'codex',
				instructions: 'Do the thing',
				model: 'gpt-5.3-codex',
				effort: 'high',
				permissionMode: 'plan',
				skipPermissions: false,
				timeoutSec: 900.4,
				maxBudgetUsd: 12.345,
				envPassthrough: ['OPENAI_API_KEY', 42, 'CODEX_ACCESS_TOKEN']
			});
			expect(out).toEqual({
				provider: 'codex',
				instructions: 'Do the thing',
				model: 'gpt-5.3-codex',
				effort: 'high',
				permissionMode: 'plan',
				skipPermissions: false,
				timeoutSec: 900,
				maxBudgetUsd: 12.35,
				envPassthrough: ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']
			});
		});

		it('treats null optionals as absent (legacy wire representation)', () => {
			const out = normalizeFleetAgentModelExecution({
				provider: 'claude-code',
				instructions: 'x',
				model: null,
				effort: null,
				permissionMode: null,
				skipPermissions: null,
				timeoutSec: null,
				maxBudgetUsd: null,
				envPassthrough: null
			});
			expect(out).toEqual({ provider: 'claude-code', instructions: 'x' });
		});

		it.each([
			[null, /missing/],
			['string', /missing/],
			[{ provider: 'gemini', instructions: 'x' }, /provider/],
			[{ provider: 'claude-code' }, /instructions/],
			[{ provider: 'claude-code', instructions: '   ' }, /instructions/],
			[
				{ provider: 'claude-code', instructions: 'x'.repeat(FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES + 1) },
				/bytes/
			],
			[{ provider: 'claude-code', instructions: 'x', model: 'opus; rm -rf /' }, /model/],
			[{ provider: 'claude-code', instructions: 'x', model: '-opus' }, /model/],
			[{ provider: 'claude-code', instructions: 'x', effort: 'extreme' }, /effort/],
			[{ provider: 'claude-code', instructions: 'x', permissionMode: 'bypassPermissions' }, /permissionMode/],
			[{ provider: 'claude-code', instructions: 'x', skipPermissions: 'yes' }, /skipPermissions/],
			[{ provider: 'claude-code', instructions: 'x', timeoutSec: 30 }, /timeoutSec/],
			[{ provider: 'claude-code', instructions: 'x', timeoutSec: 99999 }, /timeoutSec/],
			[{ provider: 'claude-code', instructions: 'x', timeoutSec: '600' }, /timeoutSec/],
			[{ provider: 'claude-code', instructions: 'x', maxBudgetUsd: 0 }, /maxBudgetUsd/],
			[{ provider: 'claude-code', instructions: 'x', maxBudgetUsd: 10_000 }, /maxBudgetUsd/],
			[{ provider: 'claude-code', instructions: 'x', envPassthrough: 'HOME' }, /envPassthrough/]
		])('refuses %j', (raw, message) => {
			expect(() => normalizeFleetAgentModelExecution(raw)).toThrowError(FleetAgentExecutionError);
			expect(() => normalizeFleetAgentModelExecution(raw)).toThrowError(message);
		});

		it('measures instructions in UTF-8 bytes, not characters', () => {
			// 4 bytes per character; ~41k chars overflow the 160 KB cap even
			// though the character count alone would fit.
			const emoji = '😀'.repeat(41_000);
			expect(() =>
				normalizeFleetAgentModelExecution({ provider: 'claude-code', instructions: emoji })
			).toThrowError(/bytes/);
		});
	});
});
