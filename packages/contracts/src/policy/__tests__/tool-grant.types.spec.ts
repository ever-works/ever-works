import { describe, expect, it } from 'vitest';

import { MERGE_POLICY_SCOPE_PRECEDENCE } from '../merge-policy.types.js';
import {
	CREDENTIAL_KEY_PATTERN,
	credentialRefPattern,
	isCredentialKey,
	matchesAnyToolPattern,
	matchesToolPattern,
	PLATFORM_DEFAULT_TOOL_GRANT,
	TOOL_GRANT_PATTERN,
	TOOL_GRANT_SCOPE_PRECEDENCE,
	TOOL_NAME_PATTERN,
	toolPatternCovers
} from '../tool-grant.types.js';

/** Every credential ref captured from `input`, using a fresh (unshared) regex. */
const credRefs = (input: string): string[] => [...input.matchAll(credentialRefPattern())].map((m) => m[1]);

describe('TOOL_GRANT_SCOPE_PRECEDENCE', () => {
	it('lists the four scopes least specific first', () => {
		expect(TOOL_GRANT_SCOPE_PRECEDENCE).toEqual(['tenant', 'organization', 'work', 'agent']);
	});

	it('has exactly four members and no duplicates', () => {
		expect(TOOL_GRANT_SCOPE_PRECEDENCE).toHaveLength(4);
		expect(new Set(TOOL_GRANT_SCOPE_PRECEDENCE).size).toBe(4);
	});

	it('orders tenant before organization before work before agent', () => {
		// The resolver sorts supplied layers by indexOf into this array. Because a
		// child may only NARROW what its ancestors granted, inverting this order
		// would let a tenant row WIDEN an agent row — a privilege escalation, not
		// a cosmetic reordering.
		const at = (scope: string): number => TOOL_GRANT_SCOPE_PRECEDENCE.indexOf(scope as never);
		expect(at('tenant')).toBeLessThan(at('organization'));
		expect(at('organization')).toBeLessThan(at('work'));
		expect(at('work')).toBeLessThan(at('agent'));
	});

	it('IS frozen', () => {
		// Asymmetry worth knowing: this one is Object.freeze'd at declaration while
		// MERGE_POLICY_SCOPE_PRECEDENCE is only `readonly` in the type system.
		expect(Object.isFrozen(TOOL_GRANT_SCOPE_PRECEDENCE)).toBe(true);
	});

	it('matches the merge-policy lattice exactly', () => {
		// Both matrices are documented as the SAME four levels. A divergence
		// between them should be a deliberate decision, not a drift.
		expect(TOOL_GRANT_SCOPE_PRECEDENCE).toEqual(MERGE_POLICY_SCOPE_PRECEDENCE);
	});
});

describe('PLATFORM_DEFAULT_TOOL_GRANT', () => {
	it('allows everything and denies nothing', () => {
		expect(PLATFORM_DEFAULT_TOOL_GRANT.allow).toEqual(['*']);
		expect(PLATFORM_DEFAULT_TOOL_GRANT.deny).toEqual([]);
	});

	it('is DEEPLY frozen — object plus both arrays', () => {
		// Contrast PLATFORM_DEFAULT_MERGE_POLICY, whose nested arrays are NOT
		// frozen. Here a stray `matrix.allow.push()` throws instead of corrupting
		// the module-level constant for the whole process.
		expect(Object.isFrozen(PLATFORM_DEFAULT_TOOL_GRANT)).toBe(true);
		expect(Object.isFrozen(PLATFORM_DEFAULT_TOOL_GRANT.allow)).toBe(true);
		expect(Object.isFrozen(PLATFORM_DEFAULT_TOOL_GRANT.deny)).toBe(true);
	});

	it('throws rather than accepting a push onto its allow list', () => {
		expect(() => PLATFORM_DEFAULT_TOOL_GRANT.allow.push('git_*')).toThrow(TypeError);
		expect(PLATFORM_DEFAULT_TOOL_GRANT.allow).toEqual(['*']);
	});

	it('subtracts nothing until an operator writes a row', () => {
		// The whole back-compat promise of the feature: before the matrix existed
		// every tool the per-Agent permission flags allowed stayed reachable, so
		// the default must match any name and deny none.
		expect(matchesAnyToolPattern(PLATFORM_DEFAULT_TOOL_GRANT.allow, 'any_tool_at_all')).toBe(true);
		expect(matchesAnyToolPattern(PLATFORM_DEFAULT_TOOL_GRANT.deny, 'any_tool_at_all')).toBe(false);
	});

	it('stores only patterns its own validator accepts', () => {
		for (const pattern of PLATFORM_DEFAULT_TOOL_GRANT.allow) {
			expect(TOOL_GRANT_PATTERN.test(pattern)).toBe(true);
		}
	});
});

describe('matchesToolPattern', () => {
	it.each([
		['*', 'anything', true],
		['*', '*', true],
		['git_*', 'git_commit', true],
		['git_*', 'git_', true],
		['git_*', 'git', false],
		['git_*', 'deploy_work', false],
		['commitToRepo', 'committorepo', true],
		['GIT_*', 'git_commit', true],
		['git_*', 'GIT_COMMIT', true],
		['commitToRepo', 'commitToRepo', true],
		['commitToRepo', 'commitToRepoNow', false],
		['  git_*  ', '  git_commit  ', true],
		['a', 'ab', false]
	] as [string, string, boolean][])('pattern %s vs tool %s is %s', (pattern, toolName, expected) => {
		expect(matchesToolPattern(pattern, toolName)).toBe(expected);
	});

	it.each([
		['an empty pattern', '', 'git_commit'],
		['a whitespace-only pattern', '   ', 'git_commit'],
		['an empty tool name', '*', ''],
		['a whitespace-only tool name', '*', '   '],
		['both empty', '', '']
	] as [string, string, string][])('fails closed for %s', (_label, pattern, toolName) => {
		// Note the second half: even the `*` wildcard refuses a blank tool name.
		// That is the fail-closed posture — a nameless call is never granted.
		expect(matchesToolPattern(pattern, toolName)).toBe(false);
	});

	it('treats "**" as a prefix glob for a literal star, NOT as a super-wildcard', () => {
		// GOTCHA: `p === '*'` is checked first, so '**' falls through to the
		// endsWith branch and slices to '*', matching only names that literally
		// START with a star. Anyone writing '**' expecting "everything" gets the
		// opposite of what they intended.
		expect(matchesToolPattern('**', 'xx')).toBe(false);
		expect(matchesToolPattern('**', 'anything')).toBe(false);
		expect(matchesToolPattern('**', '*foo')).toBe(true);
	});

	it('only honours a TRAILING star', () => {
		// A leading or interior star is matched literally, not as a glob.
		expect(matchesToolPattern('*git', 'git_commit')).toBe(false);
		expect(matchesToolPattern('g*t', 'git')).toBe(false);
		expect(matchesToolPattern('g*t', 'g*t')).toBe(true);
	});
});

describe('matchesAnyToolPattern', () => {
	it('returns false for an empty pattern list', () => {
		// No patterns means nothing matches — the narrowest possible reading, and
		// what makes an explicitly empty `allow` mean "this scope grants nothing".
		expect(matchesAnyToolPattern([], 'git_commit')).toBe(false);
	});

	it('returns true as soon as one pattern matches', () => {
		expect(matchesAnyToolPattern(['a', 'git_*'], 'git_commit')).toBe(true);
	});

	it('returns false when no pattern matches', () => {
		expect(matchesAnyToolPattern(['a', 'b'], 'c')).toBe(false);
	});

	it('skips a blank entry rather than treating it as a wildcard', () => {
		expect(matchesAnyToolPattern([''], 'git_commit')).toBe(false);
		expect(matchesAnyToolPattern(['   '], 'git_commit')).toBe(false);
		expect(matchesAnyToolPattern(['', '*'], 'git_commit')).toBe(true);
	});

	it('still refuses an empty tool name even against a wildcard list', () => {
		expect(matchesAnyToolPattern(['*'], '')).toBe(false);
	});

	it.each([
		['*', 'git_commit'],
		['git_*', 'git_commit'],
		['git_*', 'deploy_work'],
		['git_commit', 'git_commit'],
		['', 'git_commit']
	] as [string, string][])('agrees with matchesToolPattern for the single-element list [%s]', (pattern, toolName) => {
		expect(matchesAnyToolPattern([pattern], toolName)).toBe(matchesToolPattern(pattern, toolName));
	});
});

describe('toolPatternCovers — the narrowing test', () => {
	it.each([
		['*', 'git_*', true],
		['*', '*', true],
		['*', 'commitToRepo', true],
		['git_*', 'git_commit', true],
		['git_*', 'git_*', true],
		['git_*', 'git', false],
		['git_*', '*', false],
		['git_commit', 'git_*', false],
		['git_commit', 'git_commit', true],
		['GIT_COMMIT', 'git_commit', true],
		['a*', 'a', true],
		['a', 'a*', false],
		['deploy_*', 'git_commit', false],
		['  git_*  ', '  git_commit  ', true]
	] as [string, string, boolean][])('outer %s covers inner %s: %s', (outer, inner, expected) => {
		expect(toolPatternCovers(outer, inner)).toBe(expected);
	});

	it('never lets a narrower ancestor cover a child asking for everything', () => {
		// SECURITY: this pair is the no-upward-widening rule. A concrete or
		// prefixed outer must not cover a wildcard inner, or an agent-level row
		// could reach past what its tenant granted.
		expect(toolPatternCovers('git_*', '*')).toBe(false);
		expect(toolPatternCovers('git_commit', '*')).toBe(false);
		expect(toolPatternCovers('git_commit', 'git_*')).toBe(false);
	});

	it('is asymmetric: a glob covers its own prefix but not the reverse', () => {
		expect(toolPatternCovers('a*', 'a')).toBe(true);
		expect(toolPatternCovers('a', 'a*')).toBe(false);
		expect(toolPatternCovers('a*', 'a')).not.toBe(toolPatternCovers('a', 'a*'));
	});

	it.each([
		['an empty outer', '', 'git_commit'],
		['an empty inner', 'git_*', ''],
		['a whitespace-only outer', '  ', 'git_commit'],
		['a whitespace-only inner', 'git_*', '  ']
	] as [string, string, string][])('fails closed for %s', (_label, outer, inner) => {
		expect(toolPatternCovers(outer, inner)).toBe(false);
	});
});

describe('pattern helpers — argument robustness', () => {
	it('throws TypeError on null/undefined rather than silently permitting', () => {
		// The signatures are `string` / `readonly string[]`, so callers are
		// expected to run the sanitizer first. Pinned so nobody "fixes" these into
		// returning a permissive value for garbage input.
		expect(() => matchesToolPattern(null as never, 'git_commit')).toThrow(TypeError);
		expect(() => matchesToolPattern('*', undefined as never)).toThrow(TypeError);
		expect(() => matchesAnyToolPattern(undefined as never, 'git_commit')).toThrow(TypeError);
		expect(() => toolPatternCovers('git_*', undefined as never)).toThrow(TypeError);
		expect(() => toolPatternCovers(null as never, 'git_commit')).toThrow(TypeError);
	});
});

// NOTE: TOOL_NAME_PATTERN is exported but currently has ZERO consumers in the
// repo (its declaration is the only hit). Pinned anyway because it is public
// API of the contracts package.
describe('TOOL_NAME_PATTERN', () => {
	it.each([['git_commit'], ['a'], ['A.b:c-d'], ['0'], ['_'], ['-'], ['.'], [':'], ['a'.repeat(120)]])(
		'accepts %s',
		(name) => {
			expect(TOOL_NAME_PATTERN.test(name)).toBe(true);
		}
	);

	it.each([['*'], ['git_*'], [''], ['has space'], ['tool/name'], ['tool@name'], ['emoji-✨']])(
		'rejects %s',
		(name) => {
			expect(TOOL_NAME_PATTERN.test(name)).toBe(false);
		}
	);

	it('rejects the star forms that TOOL_GRANT_PATTERN accepts', () => {
		// This is exactly what separates a tool NAME from a grant PATTERN.
		expect(TOOL_NAME_PATTERN.test('*')).toBe(false);
		expect(TOOL_GRANT_PATTERN.test('*')).toBe(true);
		expect(TOOL_NAME_PATTERN.test('git_*')).toBe(false);
		expect(TOOL_GRANT_PATTERN.test('git_*')).toBe(true);
	});

	it('is anchored, so it cannot match a valid substring of an invalid name', () => {
		// A naive unanchored /[A-Za-z0-9_.:-]{1,120}/ would happily match "bad"
		// inside "bad name!". The ^...$ anchors are the whole point.
		expect(TOOL_NAME_PATTERN.test('bad name!')).toBe(false);
		expect(TOOL_NAME_PATTERN.test('\ngit')).toBe(false);
		expect(TOOL_NAME_PATTERN.test('git\n')).toBe(false);
	});

	it.each([
		[119, true],
		[120, true],
		[121, false]
	] as [number, boolean][])('a %d-character name is accepted: %s', (length, expected) => {
		expect(TOOL_NAME_PATTERN.test('a'.repeat(length))).toBe(expected);
	});
});

describe('TOOL_GRANT_PATTERN', () => {
	it.each([
		['*'],
		['git_*'],
		['git_commit'],
		['_x'],
		['.'],
		['-'],
		[':'],
		['A.b:c-d*'],
		['a'.repeat(120)],
		['a'.repeat(120) + '*']
	])('accepts %s', (pattern) => {
		expect(TOOL_GRANT_PATTERN.test(pattern)).toBe(true);
	});

	it.each([
		['**'],
		['*git'],
		['g*t'],
		['git_**'],
		[''],
		['  '],
		['a b*'],
		['tool/name*'],
		['\ngit_*'],
		['git_*\n'],
		['a'.repeat(121)],
		['a'.repeat(121) + '*']
	])('rejects %s', (pattern) => {
		expect(TOOL_GRANT_PATTERN.test(pattern)).toBe(false);
	});

	it('bounds the NAME at 120, so the longest legal grant is 121 characters', () => {
		// The {1,120} quantifier counts the name only; the trailing star is extra.
		// Classic off-by-one seam — pin both sides of it.
		expect(TOOL_GRANT_PATTERN.test('a'.repeat(120))).toBe(true);
		expect(TOOL_GRANT_PATTERN.test('a'.repeat(120) + '*')).toBe(true);
		expect('a'.repeat(120).concat('*')).toHaveLength(121);
		expect(TOOL_GRANT_PATTERN.test('a'.repeat(121))).toBe(false);
	});

	it.each([['git_commit'], ['a'], ['A.b:c-d'], ['_'], ['a'.repeat(120)]])(
		'accepts every tool NAME the name pattern accepts, including %s',
		(name) => {
			// Superset relation: any legal tool name must also be a legal (exact)
			// grant pattern, otherwise an operator could not grant a real tool.
			expect(TOOL_NAME_PATTERN.test(name)).toBe(true);
			expect(TOOL_GRANT_PATTERN.test(name)).toBe(true);
		}
	);
});

describe('credentialRefPattern', () => {
	it('is a global regex', () => {
		expect(credentialRefPattern().flags).toBe('g');
		expect(credentialRefPattern().global).toBe(true);
	});

	it('returns a NEW instance on every call', () => {
		expect(credentialRefPattern()).not.toBe(credentialRefPattern());
	});

	it('alternates true/false on a reused instance because /g carries lastIndex', () => {
		// THIS is the bug the factory exists to prevent. A shared module-level
		// constant would make `.test()` return false on every second call, so a
		// second scan of the same string would report "no credential refs" and
		// skip resolution (or skip validation). Any refactor to a shared constant
		// must break this test.
		const re = credentialRefPattern();
		expect(re.test('{{cred.API_KEY}}')).toBe(true);
		expect(re.lastIndex).toBe(16);
		expect(re.test('{{cred.API_KEY}}')).toBe(false);
		expect(re.lastIndex).toBe(0);
		expect(re.test('{{cred.API_KEY}}')).toBe(true);
	});

	it('gives a fresh instance the answer the reused one got wrong', () => {
		const stale = credentialRefPattern();
		stale.test('{{cred.API_KEY}}');
		expect(stale.test('{{cred.API_KEY}}')).toBe(false);
		expect(credentialRefPattern().test('{{cred.API_KEY}}')).toBe(true);
	});

	it('captures every key in a string', () => {
		expect(credRefs('x {{cred.A}} y {{cred.B}} z')).toEqual(['A', 'B']);
	});

	it('tolerates whitespace inside the braces', () => {
		expect(credRefs('{{  cred.A_1  }}')).toEqual(['A_1']);
		expect(credRefs('{{\tcred.A\n}}')).toEqual(['A']);
	});

	it('is UNANCHORED so refs can sit mid-string', () => {
		// Deliberate: refs are interpolated into larger values (URLs, headers,
		// bodies), never matched as a whole field.
		expect(credRefs('prefix{{cred.K}}suffix')).toEqual(['K']);
	});

	it.each([
		['{{creds.A}}'],
		['{{cred.}}'],
		['{{cred.-bad}}'],
		['{{cred..bad}}'],
		['{{ cred . A }}'],
		['{cred.A}'],
		['{{CRED.A}}'],
		['{{cred.a b}}']
	])('finds no ref in %s', (input) => {
		// Note `{{ cred . A }}`: whitespace INSIDE the braces is tolerated, but a
		// space around the dot is not — the two are easy to conflate.
		expect(credRefs(input)).toEqual([]);
	});

	it('accepts a 64-character key and rejects a 65-character one outright', () => {
		// The key is `[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}` = 64 chars max. An
		// over-long key produces NO match at all rather than a truncated one, so
		// it can never silently resolve a DIFFERENT secret than the author meant.
		expect(credRefs('{{cred.' + 'a'.repeat(64) + '}}')).toEqual(['a'.repeat(64)]);
		expect(credRefs('{{cred.' + 'a'.repeat(65) + '}}')).toEqual([]);
	});

	it('rejects a key that starts with a dot or dash', () => {
		expect(credRefs('{{cred..A}}')).toEqual([]);
		expect(credRefs('{{cred.-A}}')).toEqual([]);
		expect(credRefs('{{cred._A}}')).toEqual(['_A']);
	});
});

describe('CREDENTIAL_KEY_PATTERN and isCredentialKey', () => {
	const ACCEPTED = ['A', 'a', '_a', '0a', '9', 'a-b.c_d', 'A'.repeat(64)];
	const REJECTED = ['.bad', '-bad', '', 'a:b', 'a b', 'a\nb', 'a/b', 'a*', 'a'.repeat(65)];

	it.each(ACCEPTED.map((k) => [k]))('accepts %s', (key) => {
		expect(CREDENTIAL_KEY_PATTERN.test(key)).toBe(true);
	});

	it.each(REJECTED.map((k) => [k]))('rejects %s', (key) => {
		// `a:b` is worth calling out: a colon is legal in a TOOL name but not in a
		// credential key, so the two character classes are NOT interchangeable.
		expect(CREDENTIAL_KEY_PATTERN.test(key)).toBe(false);
	});

	it.each([
		[63, true],
		[64, true],
		[65, false]
	] as [number, boolean][])('a %d-character key is accepted: %s', (length, expected) => {
		expect(CREDENTIAL_KEY_PATTERN.test('a'.repeat(length))).toBe(expected);
	});

	it('is anchored, so it cannot match a valid prefix of an invalid key', () => {
		expect(CREDENTIAL_KEY_PATTERN.test('bad key')).toBe(false);
		expect(CREDENTIAL_KEY_PATTERN.test('\nA')).toBe(false);
		expect(CREDENTIAL_KEY_PATTERN.test('A\n')).toBe(false);
	});

	it('is stateless — it carries no /g flag', () => {
		// Unlike credentialRefPattern(), this one is safe to share, which is why
		// it is exported as a constant rather than a factory.
		expect(CREDENTIAL_KEY_PATTERN.global).toBe(false);
		expect(CREDENTIAL_KEY_PATTERN.test('API_KEY')).toBe(true);
		expect(CREDENTIAL_KEY_PATTERN.test('API_KEY')).toBe(true);
	});

	it.each([...ACCEPTED, ...REJECTED].map((k) => [k]))('isCredentialKey agrees with the pattern for %s', (key) => {
		expect(isCredentialKey(key)).toBe(CREDENTIAL_KEY_PATTERN.test(key));
	});

	it('BUG: returns true for non-string values because RegExp.test stringifies', () => {
		// `CREDENTIAL_KEY_PATTERN.test(value)` coerces its argument, so
		// `undefined` becomes the STRING 'undefined', which matches the pattern.
		// Consumers use `if (!isCredentialKey(key))` as a security gate, and a
		// null/undefined key sails straight through it. Pinned as CURRENT
		// behaviour so a fix is a visible, intentional change here.
		expect(isCredentialKey(undefined as never)).toBe(true);
		expect(isCredentialKey(null as never)).toBe(true);
		expect(isCredentialKey(123 as never)).toBe(true);
		expect(isCredentialKey(0 as never)).toBe(true);
		expect(isCredentialKey(true as never)).toBe(true);
		expect(isCredentialKey(false as never)).toBe(true);
		expect(isCredentialKey(Number.NaN as never)).toBe(true);
		// A one-element array stringifies to its single member.
		expect(isCredentialKey(['A'] as never)).toBe(true);
	});

	it('returns false for the non-strings that happen to stringify badly', () => {
		// The balancing half of the bug above: these are rejected only by
		// accident of their String() form, not by any type check.
		expect(isCredentialKey({} as never)).toBe(false);
		expect(isCredentialKey([] as never)).toBe(false);
		expect(isCredentialKey(['a', 'b'] as never)).toBe(false);
		expect(isCredentialKey('' as never)).toBe(false);
		expect(isCredentialKey(' A ' as never)).toBe(false);
	});
});
