import { describe, expect, it } from 'vitest';

import {
	MERGE_METHODS,
	MERGE_POLICY_FIELDS,
	MERGE_POLICY_SCOPE_PRECEDENCE,
	PLATFORM_DEFAULT_MERGE_POLICY
} from '../merge-policy.types.js';

describe('MERGE_METHODS', () => {
	it('lists exactly the three supported merge strategies', () => {
		expect(MERGE_METHODS).toEqual(['merge', 'squash', 'rebase']);
	});

	it('has exactly three members', () => {
		// Regression guard against a silent addition: this array is the single
		// source of truth every `@IsIn(MERGE_METHODS)` DTO validator reads, so a
		// fourth entry widens request validation everywhere at once.
		expect(MERGE_METHODS).toHaveLength(3);
	});

	it('contains no duplicates', () => {
		expect(new Set(MERGE_METHODS).size).toBe(MERGE_METHODS.length);
	});

	it.each([['merge'], ['squash'], ['rebase']])('includes the %s method', (method) => {
		expect(MERGE_METHODS).toContain(method);
	});

	it.each([['fast-forward'], ['squash-merge'], ['ff-only'], ['Squash'], ['SQUASH']])(
		'does not include the plausible-but-absent value %s',
		(method) => {
			// Named negatives, so a "helpful" alias added to the list is caught
			// rather than quietly accepted by every validator downstream.
			expect(MERGE_METHODS).not.toContain(method as never);
		}
	);

	it('is NOT frozen at runtime', () => {
		// Current reality: `readonly` is a type-system-only guarantee here. Pinned
		// so that adding Object.freeze becomes a deliberate, visible change.
		expect(Object.isFrozen(MERGE_METHODS)).toBe(false);
	});
});

describe('MERGE_POLICY_SCOPE_PRECEDENCE', () => {
	it('lists the four scopes least specific first', () => {
		expect(MERGE_POLICY_SCOPE_PRECEDENCE).toEqual(['tenant', 'organization', 'work', 'agent']);
	});

	it('has exactly four members and no duplicates', () => {
		expect(MERGE_POLICY_SCOPE_PRECEDENCE).toHaveLength(4);
		expect(new Set(MERGE_POLICY_SCOPE_PRECEDENCE).size).toBe(4);
	});

	it('orders tenant before organization before work before agent', () => {
		// ORDER IS LOAD-BEARING: the resolver in @ever-works/agent sorts the
		// supplied layers by indexOf into this array, so reordering it inverts
		// which scope wins a field. Asserted as an explicit chain rather than
		// only via toEqual so the intent survives a reformat of the literal.
		const at = (scope: string): number => MERGE_POLICY_SCOPE_PRECEDENCE.indexOf(scope as never);
		expect(at('tenant')).toBeLessThan(at('organization'));
		expect(at('organization')).toBeLessThan(at('work'));
		expect(at('work')).toBeLessThan(at('agent'));
	});

	it('puts the most specific scope last', () => {
		expect(MERGE_POLICY_SCOPE_PRECEDENCE[MERGE_POLICY_SCOPE_PRECEDENCE.length - 1]).toBe('agent');
	});

	it('does not contain the pseudo-scope "default"', () => {
		// `'default'` is a MergePolicySource, not a storable scope — it must never
		// appear in the precedence list or the resolver would try to sort it.
		expect(MERGE_POLICY_SCOPE_PRECEDENCE).not.toContain('default' as never);
	});

	it('is NOT frozen at runtime', () => {
		// Deliberate asymmetry with TOOL_GRANT_SCOPE_PRECEDENCE, which IS frozen.
		expect(Object.isFrozen(MERGE_POLICY_SCOPE_PRECEDENCE)).toBe(false);
	});
});

describe('PLATFORM_DEFAULT_MERGE_POLICY', () => {
	it('is frozen', () => {
		expect(Object.isFrozen(PLATFORM_DEFAULT_MERGE_POLICY)).toBe(true);
	});

	it('keeps the conservative posture: agent may not merge, gate green, human approves', () => {
		// This trio IS the safety property of the whole feature. An operator opts
		// out per scope; flipping a default is never an accident.
		expect(PLATFORM_DEFAULT_MERGE_POLICY.allowAgentMerge).toBe(false);
		expect(PLATFORM_DEFAULT_MERGE_POLICY.requireGreenGate).toBe(true);
		expect(PLATFORM_DEFAULT_MERGE_POLICY.requireHumanApproval).toBe(true);
	});

	it('allows squash only', () => {
		expect(PLATFORM_DEFAULT_MERGE_POLICY.allowedMergeMethods).toEqual(['squash']);
	});

	it('protects exactly the four conventional long-lived branches', () => {
		expect(PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches).toEqual(['main', 'master', 'develop', 'stage']);
		expect(PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches).toHaveLength(4);
	});

	it('exposes exactly the five MergePolicy fields', () => {
		expect(Object.keys(PLATFORM_DEFAULT_MERGE_POLICY).sort()).toEqual([
			'allowAgentMerge',
			'allowedMergeMethods',
			'protectedBranches',
			'requireGreenGate',
			'requireHumanApproval'
		]);
	});

	it('only names methods that MERGE_METHODS declares', () => {
		// Cross-constant consistency: a default naming a method the validators
		// reject would make the platform default itself unstorable.
		for (const method of PLATFORM_DEFAULT_MERGE_POLICY.allowedMergeMethods) {
			expect(MERGE_METHODS).toContain(method);
		}
	});

	it('is only SHALLOWLY frozen — its nested arrays stay mutable', () => {
		// GOTCHA / latent bug, pinned as CURRENT behaviour: Object.freeze does not
		// recurse, so the two arrays inside the frozen default are still writable.
		// Contrast PLATFORM_DEFAULT_TOOL_GRANT, which freezes `allow` and `deny`
		// individually. If someone fixes this, THIS test must be the thing that
		// breaks, not a production consumer.
		expect(Object.isFrozen(PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches)).toBe(false);
		expect(Object.isFrozen(PLATFORM_DEFAULT_MERGE_POLICY.allowedMergeMethods)).toBe(false);
		expect(Object.isExtensible(PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches)).toBe(true);
		expect(Object.isExtensible(PLATFORM_DEFAULT_MERGE_POLICY.allowedMergeMethods)).toBe(true);
	});

	it('lets a consumer mutate the shared default array in place', () => {
		// Makes the hazard above concrete: `policy.protectedBranches.push(...)`
		// silently corrupts the module-level constant for the whole process.
		// Restored in `finally` so this spec never leaks into its neighbours.
		const branches = PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches;
		const snapshot = [...branches];
		try {
			branches.push('__mutation-probe__');
			expect(branches).toContain('__mutation-probe__');
		} finally {
			branches.length = 0;
			branches.push(...snapshot);
		}
		expect(PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches).toEqual(['main', 'master', 'develop', 'stage']);
	});

	it('refuses a top-level reassignment because the object itself is frozen', () => {
		// ESM modules are strict mode, so writing to a frozen own property throws
		// rather than failing silently.
		expect(() => {
			(PLATFORM_DEFAULT_MERGE_POLICY as { allowAgentMerge: boolean }).allowAgentMerge = true;
		}).toThrow(TypeError);
		expect(PLATFORM_DEFAULT_MERGE_POLICY.allowAgentMerge).toBe(false);
	});
});

describe('MERGE_POLICY_FIELDS', () => {
	it('lists the five field names in declaration order', () => {
		expect(MERGE_POLICY_FIELDS).toEqual([
			'allowAgentMerge',
			'requireGreenGate',
			'requireHumanApproval',
			'allowedMergeMethods',
			'protectedBranches'
		]);
	});

	it('has exactly five members and no duplicates', () => {
		expect(MERGE_POLICY_FIELDS).toHaveLength(5);
		expect(new Set(MERGE_POLICY_FIELDS).size).toBe(5);
	});

	it('covers every key of the platform default and nothing more', () => {
		// The deep merge iterates THIS array, so a field added to MergePolicy but
		// forgotten here would silently never be inheritable at any scope. Both
		// set differences are asserted so either direction of drift fails.
		const declared = new Set<string>(MERGE_POLICY_FIELDS);
		const actual = new Set<string>(Object.keys(PLATFORM_DEFAULT_MERGE_POLICY));
		expect([...actual].filter((k) => !declared.has(k))).toEqual([]);
		expect([...declared].filter((k) => !actual.has(k))).toEqual([]);
	});

	it('is NOT frozen at runtime', () => {
		expect(Object.isFrozen(MERGE_POLICY_FIELDS)).toBe(false);
	});
});
