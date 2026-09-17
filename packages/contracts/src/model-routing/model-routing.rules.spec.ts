import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	daysUntilModelAccountExpiry,
	effectiveModelAccountHealth,
	isModelAccountUsable,
	modelAccountNeedsBanner,
	parseModelPolicyScheduleKey,
	resolveModelPolicyLadder,
	sanitizeFallbackChain
} from './model-routing.rules.js';
import {
	MODEL_POLICY_SCHEDULE_SOURCES,
	MODEL_ROUTING_LIMITS,
	REASONING_EFFORTS,
	type AgentRunModelRouting,
	type ModelAccountView,
	type ModelChainEntry
} from './model-routing.types.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

const entry = (providerPluginId: string, modelId: string): ModelChainEntry => ({ providerPluginId, modelId });

describe('model routing — secrecy of the wire types', () => {
	it('gives an account view no credential field of any kind', () => {
		expectTypeOf<ModelAccountView>().not.toHaveProperty('credentials');
		expectTypeOf<ModelAccountView>().not.toHaveProperty('credentialVersion');
		expectTypeOf<keyof ModelAccountView>().not.toEqualTypeOf<'apiKey'>();
	});

	it('gives the run routing record no credential field', () => {
		expectTypeOf<AgentRunModelRouting>().not.toHaveProperty('credentials');
	});

	it('keeps the four reasoning efforts and the schedule source vocabulary', () => {
		expect(REASONING_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high']);
		expect(MODEL_POLICY_SCHEDULE_SOURCES).toContain('agent_heartbeat');
		expect(MODEL_POLICY_SCHEDULE_SOURCES).toHaveLength(7);
	});
});

describe('effectiveModelAccountHealth', () => {
	const base = { health: 'working' as const, enabled: true, credentialExpiresAt: null };

	it('reads a paused account as paused, whatever it was', () => {
		expect(effectiveModelAccountHealth({ ...base, enabled: false }, NOW)).toBe('paused');
		expect(effectiveModelAccountHealth({ ...base, health: 'invalid', enabled: false }, NOW)).toBe('paused');
	});

	it('announces an expiry 14 days ahead and not before', () => {
		expect(effectiveModelAccountHealth({ ...base, credentialExpiresAt: inDays(15) }, NOW)).toBe('working');
		expect(effectiveModelAccountHealth({ ...base, credentialExpiresAt: inDays(14) }, NOW)).toBe('expiring');
		expect(effectiveModelAccountHealth({ ...base, credentialExpiresAt: inDays(9) }, NOW)).toBe('expiring');
	});

	it('reads a passed expiry as expired and keeps a rejection until reconnect', () => {
		expect(effectiveModelAccountHealth({ ...base, credentialExpiresAt: inDays(-1) }, NOW)).toBe('expired');
		expect(effectiveModelAccountHealth({ ...base, health: 'invalid', credentialExpiresAt: inDays(30) }, NOW)).toBe(
			'invalid'
		);
	});

	it('reads a stale stored state as unknown once its reason is gone', () => {
		expect(effectiveModelAccountHealth({ ...base, health: 'paused' }, NOW)).toBe('unknown');
		expect(effectiveModelAccountHealth({ ...base, health: 'expired' }, NOW)).toBe('unknown');
	});

	it('accepts ISO strings as well as dates', () => {
		expect(effectiveModelAccountHealth({ ...base, credentialExpiresAt: inDays(2).toISOString() }, NOW)).toBe(
			'expiring'
		);
	});
});

describe('isModelAccountUsable / modelAccountNeedsBanner', () => {
	const base = { health: 'unknown' as const, enabled: true, credentialExpiresAt: null };

	it('routes to working, expiring and unknown accounts only', () => {
		expect(isModelAccountUsable(base, NOW)).toBe(true);
		expect(isModelAccountUsable({ ...base, credentialExpiresAt: inDays(5) }, NOW)).toBe(true);
		expect(isModelAccountUsable({ ...base, enabled: false }, NOW)).toBe(false);
		expect(isModelAccountUsable({ ...base, health: 'invalid' }, NOW)).toBe(false);
		expect(isModelAccountUsable({ ...base, credentialExpiresAt: inDays(-2) }, NOW)).toBe(false);
	});

	it('raises the banner inside three days, on expiry and on rejection — never for a paused account', () => {
		expect(modelAccountNeedsBanner({ ...base, credentialExpiresAt: inDays(9) }, NOW)).toBe(false);
		expect(modelAccountNeedsBanner({ ...base, credentialExpiresAt: inDays(2) }, NOW)).toBe(true);
		expect(modelAccountNeedsBanner({ ...base, credentialExpiresAt: inDays(-1) }, NOW)).toBe(true);
		expect(modelAccountNeedsBanner({ ...base, health: 'invalid' }, NOW)).toBe(true);
		expect(modelAccountNeedsBanner({ ...base, health: 'invalid', enabled: false }, NOW)).toBe(false);
	});

	it('counts whole days to expiry', () => {
		expect(daysUntilModelAccountExpiry(inDays(9), NOW)).toBe(9);
		expect(daysUntilModelAccountExpiry(null, NOW)).toBeNull();
		expect(daysUntilModelAccountExpiry('not a date', NOW)).toBeNull();
	});
});

describe('sanitizeFallbackChain', () => {
	it('never keeps the primary as its own fallback', () => {
		const result = sanitizeFallbackChain({ providerPluginId: 'provider-a', modelId: 'big' }, [
			entry('provider-a', 'big'),
			entry('provider-b', 'other')
		]);
		expect(result.chain).toEqual([entry('provider-b', 'other')]);
		expect(result.removedPrimary).toEqual([entry('provider-a', 'big')]);
	});

	it('treats the same model on another provider as a different entry', () => {
		const result = sanitizeFallbackChain({ providerPluginId: 'provider-a', modelId: 'big' }, [
			entry('gateway', 'big')
		]);
		expect(result.chain).toEqual([entry('gateway', 'big')]);
	});

	it('drops repeats and anything past three entries, keeping order', () => {
		const result = sanitizeFallbackChain(null, [
			entry('a', '1'),
			entry('a', '1'),
			entry('b', '2'),
			entry('c', '3'),
			entry('d', '4')
		]);
		expect(result.chain.map((item) => item.modelId)).toEqual(['1', '2', '3']);
		expect(result.removedDuplicates).toHaveLength(1);
		expect(result.removedOverflow).toEqual([entry('d', '4')]);
		expect(MODEL_ROUTING_LIMITS.fallbackEntriesPerPolicy).toBe(3);
	});
});

describe('resolveModelPolicyLadder', () => {
	it('falls back to defaults when nothing is set — the plugin keeps choosing', () => {
		const resolved = resolveModelPolicyLadder({});
		expect(resolved.primaryModel).toEqual({ value: null, source: 'default' });
		expect(resolved.reasoningEffort).toEqual({ value: 'medium', source: 'default' });
		expect(resolved.runTimeoutSeconds).toEqual({ value: 900, source: 'default' });
		expect(resolved.attemptTimeoutSeconds).toEqual({ value: 120, source: 'default' });
		expect(resolved.fallbackModels).toEqual({ value: [], source: 'default' });
	});

	it('lets the narrowest scope win each field independently', () => {
		const resolved = resolveModelPolicyLadder({
			workspace: {
				primaryModel: { providerPluginId: 'a', modelId: 'big' },
				reasoningEffort: 'low',
				runTimeoutSeconds: 600
			},
			agent: { primaryModel: { providerPluginId: 'a', modelId: 'fast' }, reasoningEffort: 'high' },
			schedule: { primaryModel: { providerPluginId: 'b', modelId: 'cheap' } }
		});
		expect(resolved.primaryModel).toEqual({
			value: { providerPluginId: 'b', modelId: 'cheap' },
			source: 'schedule'
		});
		// The schedule set only the model: effort comes from the Agent, timeout from the workspace.
		expect(resolved.reasoningEffort).toEqual({ value: 'high', source: 'agent' });
		expect(resolved.runTimeoutSeconds).toEqual({ value: 600, source: 'workspace' });
	});

	it('never reads a run timeout from the Agent level', () => {
		const resolved = resolveModelPolicyLadder({ agent: { runTimeoutSeconds: 120 } });
		expect(resolved.runTimeoutSeconds.source).toBe('default');
	});

	it('treats an Agent pair with neither half set as inheriting', () => {
		const resolved = resolveModelPolicyLadder({
			agent: { primaryModel: { providerPluginId: null, modelId: null } },
			workspace: { primaryModel: { providerPluginId: 'a', modelId: 'big' } }
		});
		expect(resolved.primaryModel.source).toBe('workspace');
	});

	it('keeps a provider-only Agent selection', () => {
		const resolved = resolveModelPolicyLadder({
			agent: { primaryModel: { providerPluginId: 'a', modelId: null } }
		});
		expect(resolved.primaryModel).toEqual({ value: { providerPluginId: 'a', modelId: null }, source: 'agent' });
	});

	it('distinguishes an explicit empty fallback list from inheriting, and removes the resolved primary', () => {
		const explicitEmpty = resolveModelPolicyLadder({
			agent: { fallbackModels: [] },
			workspace: { fallbackModels: [entry('a', 'x')] }
		});
		expect(explicitEmpty.fallbackModels).toEqual({ value: [], source: 'agent' });

		const withPrimary = resolveModelPolicyLadder({
			schedule: { primaryModel: { providerPluginId: 'a', modelId: 'x' } },
			workspace: { fallbackModels: [entry('a', 'x'), entry('b', 'y')] }
		});
		expect(withPrimary.fallbackModels.value).toEqual([entry('b', 'y')]);
	});
});

describe('parseModelPolicyScheduleKey', () => {
	it('splits a schedule row key on the first colon', () => {
		expect(parseModelPolicyScheduleKey('agent_heartbeat:abc')).toEqual({
			source: 'agent_heartbeat',
			ownerId: 'abc'
		});
		expect(parseModelPolicyScheduleKey('agent_heartbeat')).toBeNull();
		expect(parseModelPolicyScheduleKey(':abc')).toBeNull();
		expect(parseModelPolicyScheduleKey(undefined)).toBeNull();
	});
});
