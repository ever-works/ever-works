import { describe, expect, it } from 'vitest';

import { sanitizeMergePolicyOverride } from '../merge-policy.sanitize.js';
import { MERGE_METHODS } from '../merge-policy.types.js';

const BOOLEAN_FIELDS = ['allowAgentMerge', 'requireGreenGate', 'requireHumanApproval'] as const;

describe('sanitizeMergePolicyOverride — defensive inputs', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'squash'],
		['the empty string', ''],
		['a number', 42],
		['zero', 0],
		['false', false],
		['true', true],
		['NaN', Number.NaN]
	])('returns an empty override for %s', (_label, raw) => {
		expect(sanitizeMergePolicyOverride(raw as never)).toEqual({});
	});

	it('accepts an array without throwing and returns an empty override', () => {
		// `typeof [] === 'object'` and a non-empty array is truthy, so an array
		// slips straight past the `!raw || typeof raw !== 'object'` guard. It is
		// only saved by carrying none of the five known keys — pinned because a
		// future guard change must not start throwing on this shape.
		expect(sanitizeMergePolicyOverride([] as never)).toEqual({});
		expect(sanitizeMergePolicyOverride([1, 2, 3] as never)).toEqual({});
	});

	it('returns an empty override for an empty object', () => {
		expect(sanitizeMergePolicyOverride({})).toEqual({});
	});

	it('drops keys that are not part of MergePolicy', () => {
		// Whitelist behaviour: the sanitizer only ever COPIES the five known keys,
		// it never passes the input through, so a typo'd or hostile key cannot ride
		// into a `simple-json` column.
		const out = sanitizeMergePolicyOverride({ foo: 1, mergePolicy: true, protected_branches: ['main'] } as never);
		expect(out).toEqual({});
		expect(Object.keys(out)).toHaveLength(0);
	});
});

describe('sanitizeMergePolicyOverride — boolean flags', () => {
	it.each([
		['allowAgentMerge', true],
		['allowAgentMerge', false],
		['requireGreenGate', true],
		['requireGreenGate', false],
		['requireHumanApproval', true],
		['requireHumanApproval', false]
	] as const)('round-trips %s set to %s', (key, value) => {
		// `false` MUST survive: it is a real policy value ("do not require this"),
		// whereas an ABSENT key means "inherit". Collapsing the two would silently
		// re-enable an ancestor's requirement.
		expect(sanitizeMergePolicyOverride({ [key]: value })).toEqual({ [key]: value });
	});

	const NON_BOOLEANS: [string, unknown][] = [
		['the string "true"', 'true'],
		['the string "false"', 'false'],
		['the number 1', 1],
		['the number 0', 0],
		['null', null],
		['undefined', undefined],
		['an object', {}],
		['an array', []]
	];

	for (const key of BOOLEAN_FIELDS) {
		it.each(NON_BOOLEANS)(`drops ${key} when it is %s`, (_label, value) => {
			const out = sanitizeMergePolicyOverride({ [key]: value } as never);
			// `not.toHaveProperty` rather than `toBeUndefined`, so a regression that
			// writes `key: undefined` (present but empty) is still caught.
			expect(out).not.toHaveProperty(key);
		});
	}

	it('keeps only the boolean-typed keys of a mixed object', () => {
		const out = sanitizeMergePolicyOverride({
			allowAgentMerge: true,
			requireGreenGate: 'yes',
			requireHumanApproval: false
		} as never);
		expect(out).toEqual({ allowAgentMerge: true, requireHumanApproval: false });
	});
});

describe('sanitizeMergePolicyOverride — allowedMergeMethods', () => {
	it('round-trips a full valid list', () => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: ['merge', 'squash', 'rebase'] })).toEqual({
			allowedMergeMethods: ['merge', 'squash', 'rebase']
		});
	});

	it('preserves the caller-supplied order', () => {
		// `Array.from(new Set(...))` is insertion-ordered, so the stored list keeps
		// the operator's preference order rather than being re-sorted.
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: ['rebase', 'merge', 'squash'] })).toEqual({
			allowedMergeMethods: ['rebase', 'merge', 'squash']
		});
	});

	it('KEEPS a declared-but-empty list', () => {
		// An empty list is meaningful: "no method is allowed", i.e. refuse every
		// merge. It is NOT the same as an absent key, which means "inherit".
		const out = sanitizeMergePolicyOverride({ allowedMergeMethods: [] });
		expect(out).toHaveProperty('allowedMergeMethods', []);
	});

	it('DROPS a declared-but-entirely-invalid list', () => {
		// Dropping means "inherit", so a single typo falls back to the ancestor
		// policy rather than bricking every merge at this scope.
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: ['bogus'] } as never)).not.toHaveProperty(
			'allowedMergeMethods'
		);
	});

	it('keeps the valid remainder of a partially invalid list', () => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: ['bogus', 'squash'] } as never)).toEqual({
			allowedMergeMethods: ['squash']
		});
	});

	it('de-duplicates repeated methods', () => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: ['squash', 'squash', 'merge', 'squash'] })).toEqual({
			allowedMergeMethods: ['squash', 'merge']
		});
	});

	it('does NOT trim entries', () => {
		// GOTCHA — deliberate asymmetry with protectedBranches, which IS trimmed.
		// A padded method fails the equality check and the whole key is dropped.
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: [' squash '] } as never)).not.toHaveProperty(
			'allowedMergeMethods'
		);
	});

	it.each([['SQUASH'], ['Squash'], ['Merge'], ['REBASE']])('is case-sensitive and rejects %s', (method) => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: [method] } as never)).not.toHaveProperty(
			'allowedMergeMethods'
		);
	});

	it.each([
		['a string', 'squash'],
		['null', null],
		['an object', {}],
		['a number', 3]
	])('ignores the key when the value is %s rather than an array', (_label, value) => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: value } as never)).not.toHaveProperty(
			'allowedMergeMethods'
		);
	});

	it('drops an array of non-strings entirely', () => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: [1, null, {}] } as never)).not.toHaveProperty(
			'allowedMergeMethods'
		);
	});

	it.each(MERGE_METHODS.map((m) => [m]))('accepts %s on its own', (method) => {
		expect(sanitizeMergePolicyOverride({ allowedMergeMethods: [method] })).toEqual({
			allowedMergeMethods: [method]
		});
	});
});

describe('sanitizeMergePolicyOverride — protectedBranches', () => {
	it('round-trips a valid list', () => {
		expect(sanitizeMergePolicyOverride({ protectedBranches: ['main', 'release'] })).toEqual({
			protectedBranches: ['main', 'release']
		});
	});

	it('KEEPS a declared-but-empty list', () => {
		// "Protect nothing" is a real, storable choice and must not be confused
		// with an absent key ("inherit whatever my ancestors protect").
		expect(sanitizeMergePolicyOverride({ protectedBranches: [] })).toHaveProperty('protectedBranches', []);
	});

	it('trims entries BEFORE de-duplicating, so padded variants collapse into one', () => {
		expect(sanitizeMergePolicyOverride({ protectedBranches: [' main ', '\tmain\n', 'main'] })).toEqual({
			protectedBranches: ['main']
		});
	});

	it.each([
		['whitespace only', ['   ']],
		['the empty string', ['']],
		['a mix of blanks', ['', '  ', '\t\n']]
	])('DROPS the whole key when every entry is %s', (_label, branches) => {
		// THE SUBTLE ONE: the empty-is-meaningful carve-out tests
		// `raw.protectedBranches.length === 0` (the RAW length), not the
		// post-filter length. So a whitespace-only list means INHERIT, not
		// "protect nothing" — the opposite of the literal `[]` case above.
		expect(sanitizeMergePolicyOverride({ protectedBranches: branches })).not.toHaveProperty('protectedBranches');
	});

	it('drops non-string entries but keeps the valid remainder', () => {
		expect(sanitizeMergePolicyOverride({ protectedBranches: [1, null, undefined, {}, 'main'] } as never)).toEqual({
			protectedBranches: ['main']
		});
	});

	it('drops the whole key when no entry is a string', () => {
		expect(sanitizeMergePolicyOverride({ protectedBranches: [1, null] } as never)).not.toHaveProperty(
			'protectedBranches'
		);
	});

	it('de-duplicates CASE-SENSITIVELY, keeping all three casings', () => {
		// Deliberate seam: MergePolicy documents case-INSENSITIVE branch matching,
		// yet the Set de-dup is case-sensitive, so functionally identical entries
		// all persist. A future "normalize case on write" refactor must break here.
		expect(sanitizeMergePolicyOverride({ protectedBranches: ['main', 'MAIN', 'Main'] })).toEqual({
			protectedBranches: ['main', 'MAIN', 'Main']
		});
	});

	it('stores a fully-qualified ref verbatim', () => {
		// `refs/heads/` stripping happens at MATCH time, not at sanitize time.
		expect(sanitizeMergePolicyOverride({ protectedBranches: ['refs/heads/main'] })).toEqual({
			protectedBranches: ['refs/heads/main']
		});
	});

	it.each([
		['a string', 'main'],
		['null', null],
		['an object', {}]
	])('ignores the key when the value is %s rather than an array', (_label, value) => {
		expect(sanitizeMergePolicyOverride({ protectedBranches: value } as never)).not.toHaveProperty(
			'protectedBranches'
		);
	});
});

describe('sanitizeMergePolicyOverride — purity', () => {
	it('never mutates the input object', () => {
		const raw = {
			allowAgentMerge: true,
			allowedMergeMethods: ['squash', 'squash'] as const,
			protectedBranches: [' main ', ' main ']
		};
		const before = structuredClone(raw);
		sanitizeMergePolicyOverride(raw as never);
		expect(raw).toEqual(before);
	});

	it('returns fresh arrays that do not alias the caller state', () => {
		// Aliasing would let a later caller-side push silently edit stored policy.
		const raw = { allowedMergeMethods: ['squash'] as const, protectedBranches: ['main'] };
		const out = sanitizeMergePolicyOverride(raw as never);
		expect(out.allowedMergeMethods).not.toBe(raw.allowedMergeMethods);
		expect(out.protectedBranches).not.toBe(raw.protectedBranches);
	});
});

describe('sanitizeMergePolicyOverride — full round trip', () => {
	it('pins the whole key SET of a complete valid override', () => {
		expect(
			sanitizeMergePolicyOverride({
				allowAgentMerge: true,
				requireGreenGate: false,
				requireHumanApproval: false,
				allowedMergeMethods: ['squash', 'rebase'],
				protectedBranches: ['main', 'stage']
			})
		).toEqual({
			allowAgentMerge: true,
			requireGreenGate: false,
			requireHumanApproval: false,
			allowedMergeMethods: ['squash', 'rebase'],
			protectedBranches: ['main', 'stage']
		});
	});

	it('produces a plain object with no prototype surprises', () => {
		const out = sanitizeMergePolicyOverride({ allowAgentMerge: false });
		expect(Object.keys(out)).toEqual(['allowAgentMerge']);
	});
});
