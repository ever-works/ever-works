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
	FLEET_BYO_MODEL_PLUGIN_ID_PREFIX,
	FleetAgentExecutionError,
	fleetAgentExecutionProviderSupportsMountGrants,
	fleetModelCostUsdToCents,
	fleetModelPluginId,
	isFleetAgentExecutionMode,
	isFleetAgentExecutionProvider,
	isFleetModelPluginId,
	normalizeFleetAgentModelExecution
} from '../fleet-jobs.types';

/**
 * Fleet cost accounting (EW-777) — the shared dollar → cents conversion
 * and the bring-your-own plugin-id tag every fleet usage row carries.
 *
 * Pinned as literals because three parties (node, reconciler, settlement)
 * must agree on them, and a rounding change on one side would make the
 * Costs dashboard disagree with the run row by a cent per run.
 */
describe('fleet model cost accounting', () => {
	it('converts the CLI dollar figure to whole cents, rounding half-cents to the nearest', () => {
		expect(fleetModelCostUsdToCents(0.42)).toBe(42);
		expect(fleetModelCostUsdToCents(1)).toBe(100);
		expect(fleetModelCostUsdToCents(0)).toBe(0);
		// 0.005 USD is half a cent — nearest, not truncated.
		expect(fleetModelCostUsdToCents(0.005)).toBe(1);
		expect(fleetModelCostUsdToCents(0.004)).toBe(0);
		// Float noise on a typical CLI figure must not shave a cent.
		expect(fleetModelCostUsdToCents(1.1)).toBe(110);
		expect(fleetModelCostUsdToCents(12.345)).toBe(1235);
		// The classic IEEE-754 traps: `1.005 * 100 === 100.49999999999999`,
		// `0.285 * 100 === 28.499999999999996`. The CLI printed a decimal
		// half-cent; the decimal, not its binary approximation, decides.
		expect(fleetModelCostUsdToCents(1.005)).toBe(101);
		expect(fleetModelCostUsdToCents(0.285)).toBe(29);
		expect(fleetModelCostUsdToCents(0.145)).toBe(15);
		expect(fleetModelCostUsdToCents(0.125)).toBe(13);
		// And the snap never invents a cent that is not there.
		expect(fleetModelCostUsdToCents(0.0049)).toBe(0);
		expect(fleetModelCostUsdToCents(1e-7)).toBe(0);
	});

	it('answers null — unknown, never free — for anything that is not a finite non-negative number', () => {
		expect(fleetModelCostUsdToCents(null)).toBeNull();
		expect(fleetModelCostUsdToCents(undefined)).toBeNull();
		expect(fleetModelCostUsdToCents('0.42')).toBeNull();
		expect(fleetModelCostUsdToCents(Number.NaN)).toBeNull();
		expect(fleetModelCostUsdToCents(Number.POSITIVE_INFINITY)).toBeNull();
		expect(fleetModelCostUsdToCents(-0.01)).toBeNull();
	});

	it('tags fleet usage rows with a plugin id no real plugin can claim', () => {
		expect(FLEET_BYO_MODEL_PLUGIN_ID_PREFIX).toBe('fleet-node:');
		expect(fleetModelPluginId('claude-code')).toBe('fleet-node:claude-code');
		expect(fleetModelPluginId('codex')).toBe('fleet-node:codex');
		expect(isFleetModelPluginId('fleet-node:claude-code')).toBe(true);
		expect(isFleetModelPluginId('openrouter')).toBe(false);
		expect(isFleetModelPluginId(undefined)).toBe(false);
	});
});

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

	it('states which providers can be granted an additional writable root', () => {
		// Multi-repo Task workspaces (self-build slice C): a mount is only
		// LINKED into the primary worktree, so a provider that cannot be
		// handed the mount's real path can never write it. Both shipped CLIs
		// spell the grant `--add-dir`; a provider added to the vocabulary
		// without one must answer `false` here so the planner and the node
		// refuse the Task instead of running a job that silently no-ops.
		for (const provider of FLEET_AGENT_EXECUTION_PROVIDERS) {
			expect(fleetAgentExecutionProviderSupportsMountGrants(provider)).toBe(true);
		}
		expect(fleetAgentExecutionProviderSupportsMountGrants('gemini' as never)).toBe(false);
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
