import { describe, expect, it } from 'vitest';

import * as policy from '../index.js';

/**
 * The barrel declares nothing of its own (five `export *` lines), but it IS the
 * public surface every consumer reaches through `@ever-works/contracts`. A
 * dropped re-export line compiles fine here and only breaks at the call site in
 * another package, so it is pinned explicitly.
 *
 * Type-only exports are deliberately NOT asserted: they do not exist at runtime,
 * and any such check would be a no-op that always passes.
 */

const FUNCTION_EXPORTS = [
	'sanitizeMergePolicyOverride',
	'sanitizeToolGrantOverride',
	'matchesToolPattern',
	'matchesAnyToolPattern',
	'toolPatternCovers',
	'credentialRefPattern',
	'isCredentialKey'
] as const;

const VALUE_EXPORTS = [
	'MERGE_METHODS',
	'MERGE_POLICY_SCOPE_PRECEDENCE',
	'PLATFORM_DEFAULT_MERGE_POLICY',
	'MERGE_POLICY_FIELDS',
	'TOOL_GRANT_SCOPE_PRECEDENCE',
	'PLATFORM_DEFAULT_TOOL_GRANT',
	'AGENT_INIT_SCRIPT_MAX_BYTES',
	'TOOL_NAME_PATTERN',
	'TOOL_GRANT_PATTERN',
	'CREDENTIAL_KEY_PATTERN'
] as const;

const REGEXP_EXPORTS = ['TOOL_NAME_PATTERN', 'TOOL_GRANT_PATTERN', 'CREDENTIAL_KEY_PATTERN'] as const;

describe('policy barrel', () => {
	it.each(FUNCTION_EXPORTS.map((name) => [name]))('re-exports %s as a function', (name) => {
		expect(typeof (policy as Record<string, unknown>)[name]).toBe('function');
	});

	it.each(VALUE_EXPORTS.map((name) => [name]))('re-exports %s as a defined value', (name) => {
		expect((policy as Record<string, unknown>)[name]).toBeDefined();
	});

	it.each(REGEXP_EXPORTS.map((name) => [name]))('re-exports %s as a RegExp', (name) => {
		expect((policy as Record<string, unknown>)[name]).toBeInstanceOf(RegExp);
	});

	it('exposes exactly these 17 runtime symbols', () => {
		// Regression guard in BOTH directions: a re-export accidentally deleted
		// from index.ts fails here, and a NEW runtime export added without a spec
		// also fails here — forcing the author back to cover it.
		expect(Object.keys(policy).sort()).toEqual([...FUNCTION_EXPORTS, ...VALUE_EXPORTS].sort());
		expect(Object.keys(policy)).toHaveLength(17);
	});

	it('names each of the five source modules in the barrel', () => {
		// One symbol per `export *` line, so a whole missing line is unmissable.
		expect(policy.MERGE_METHODS).toBeDefined(); // merge-policy.types.js
		expect(policy.sanitizeMergePolicyOverride).toBeDefined(); // merge-policy.sanitize.js
		expect(policy.TOOL_GRANT_SCOPE_PRECEDENCE).toBeDefined(); // tool-grant.types.js
		expect(policy.sanitizeToolGrantOverride).toBeDefined(); // tool-grant.sanitize.js
		expect(policy.AGENT_INIT_SCRIPT_MAX_BYTES).toBeDefined(); // agent-capabilities.types.js
	});

	it('re-exports the same object identity the source module declares', () => {
		// Guards against a barrel that clones or wraps rather than re-exporting —
		// `Object.isFrozen` checks elsewhere would then be testing a copy.
		expect(Object.isFrozen(policy.PLATFORM_DEFAULT_TOOL_GRANT)).toBe(true);
		expect(policy.credentialRefPattern()).not.toBe(policy.credentialRefPattern());
	});
});
