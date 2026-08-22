import { describe, expect, it } from 'vitest';

import { sanitizeToolGrantOverride } from '../tool-grant.sanitize.js';

const FIELDS = ['allow', 'deny'] as const;

describe('sanitizeToolGrantOverride — defensive inputs', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['a string', '*'],
		['the empty string', ''],
		['a number', 42],
		['zero', 0],
		['false', false],
		['true', true],
		['NaN', Number.NaN]
	])('returns an empty override for %s', (_label, raw) => {
		expect(sanitizeToolGrantOverride(raw as never)).toEqual({});
	});

	it('accepts an array without throwing and returns an empty override', () => {
		// `typeof [] === 'object'`, so an array is NOT excluded by the guard. It
		// survives only because it carries neither an `allow` nor a `deny` key.
		expect(sanitizeToolGrantOverride([] as never)).toEqual({});
		expect(sanitizeToolGrantOverride([1, 2] as never)).toEqual({});
	});

	it('returns an empty override for an empty object', () => {
		const out = sanitizeToolGrantOverride({});
		expect(out).toEqual({});
		expect(Object.keys(out)).toHaveLength(0);
	});

	it('reads only `allow` and `deny`, never a look-alike key', () => {
		// A typo'd key must not become a grant. `allowed` here is deliberately one
		// character away from the real field name.
		const out = sanitizeToolGrantOverride({ note: 'hi', allowed: ['*'], denied: ['x'] } as never);
		expect(out).toEqual({});
	});
});

describe('sanitizeToolGrantOverride — allow', () => {
	it('round-trips a wildcard grant', () => {
		expect(sanitizeToolGrantOverride({ allow: ['*'] })).toEqual({ allow: ['*'] });
	});

	it('round-trips a list of concrete and prefixed patterns', () => {
		expect(sanitizeToolGrantOverride({ allow: ['git_*', 'deploy_commit'] })).toEqual({
			allow: ['git_*', 'deploy_commit']
		});
	});

	it('preserves the caller-supplied order', () => {
		expect(sanitizeToolGrantOverride({ allow: ['z_tool', 'a_tool', '*'] })).toEqual({
			allow: ['z_tool', 'a_tool', '*']
		});
	});

	it('KEEPS a declared-but-empty allow', () => {
		// An empty allow is the STRONGEST narrowing there is: "this scope grants
		// nothing". It is the opposite of an absent key ("inherit"), so collapsing
		// the two would silently re-grant everything the ancestors allowed.
		expect(sanitizeToolGrantOverride({ allow: [] })).toHaveProperty('allow', []);
	});

	it('DROPS a declared-but-entirely-invalid allow', () => {
		// Drop means inherit. Turning garbage into "grant nothing" would take a
		// running tenant offline on a single typo, so the safe failure is to fall
		// back to the ancestor grant instead.
		expect(sanitizeToolGrantOverride({ allow: ['bad name'] })).not.toHaveProperty('allow');
		expect(sanitizeToolGrantOverride({ allow: ['!!', '  '] })).not.toHaveProperty('allow');
	});

	it('keeps the valid remainder of a partially invalid allow', () => {
		expect(sanitizeToolGrantOverride({ allow: ['bad name', 'git_*'] })).toEqual({ allow: ['git_*'] });
	});
});

describe('sanitizeToolGrantOverride — deny follows the same four rules', () => {
	it('round-trips a valid deny list', () => {
		expect(sanitizeToolGrantOverride({ deny: ['secret_tool', 'admin_*'] })).toEqual({
			deny: ['secret_tool', 'admin_*']
		});
	});

	it('KEEPS a declared-but-empty deny', () => {
		expect(sanitizeToolGrantOverride({ deny: [] })).toHaveProperty('deny', []);
	});

	it('DROPS a declared-but-entirely-invalid deny', () => {
		// Safe because a deny only ever subtracts: dropping one cannot widen
		// anything, it just falls back to the inherited deny set.
		expect(sanitizeToolGrantOverride({ deny: ['bad name'] })).not.toHaveProperty('deny');
	});

	it('keeps the valid remainder of a partially invalid deny', () => {
		expect(sanitizeToolGrantOverride({ deny: ['g*t', 'admin_*'] })).toEqual({ deny: ['admin_*'] });
	});
});

describe('sanitizeToolGrantOverride — the two fields are independent', () => {
	it('drops an invalid allow while keeping a valid deny', () => {
		// One field's validity must never affect the other, or a typo in `allow`
		// would quietly discard a deliberate `deny`.
		const out = sanitizeToolGrantOverride({ allow: ['!!'], deny: ['secret_tool'] });
		expect(out).toEqual({ deny: ['secret_tool'] });
		expect(out).not.toHaveProperty('allow');
	});

	it('drops an invalid deny while keeping a valid allow', () => {
		const out = sanitizeToolGrantOverride({ allow: ['git_*'], deny: ['bad name'] });
		expect(out).toEqual({ allow: ['git_*'] });
		expect(out).not.toHaveProperty('deny');
	});

	it('keeps both keys when one is explicitly empty', () => {
		expect(sanitizeToolGrantOverride({ allow: ['*'], deny: [] })).toEqual({ allow: ['*'], deny: [] });
	});
});

describe('sanitizeToolGrantOverride — trim, then validate, then de-duplicate', () => {
	it.each(FIELDS)('trims %s entries BEFORE testing them against the pattern', (field) => {
		// Order matters: TOOL_GRANT_PATTERN is anchored and rejects leading or
		// trailing whitespace, so without the trim a padded-but-legal pattern
		// would be thrown away instead of accepted.
		expect(sanitizeToolGrantOverride({ [field]: ['  git_*  '] })).toEqual({ [field]: ['git_*'] });
	});

	it.each(FIELDS)('de-duplicates %s AFTER trimming', (field) => {
		expect(sanitizeToolGrantOverride({ [field]: ['git_*', ' git_* ', 'git_*'] })).toEqual({ [field]: ['git_*'] });
	});

	it('rescues a newline-padded pattern that TOOL_GRANT_PATTERN alone would reject', () => {
		// TOOL_GRANT_PATTERN is anchored with ^...$ and rejects 'git_*\n' outright,
		// but the sanitizer never shows it the raw entry — the trim runs first. So
		// a pattern pasted with a trailing newline is STORED, not dropped.
		expect(sanitizeToolGrantOverride({ allow: ['git_*\n'] })).toEqual({ allow: ['git_*'] });
		expect(sanitizeToolGrantOverride({ allow: ['\n git_* \t'] })).toEqual({ allow: ['git_*'] });
	});

	it('de-duplicates CASE-SENSITIVELY, keeping both casings', () => {
		// Deliberate seam: matchesToolPattern is case-INSENSITIVE, so 'Git_*' and
		// 'git_*' are functionally identical, yet both persist in storage. A
		// future "normalize case on write" refactor must break loudly here.
		expect(sanitizeToolGrantOverride({ allow: ['Git_*', 'git_*'] })).toEqual({ allow: ['Git_*', 'git_*'] });
	});
});

describe('sanitizeToolGrantOverride — malformed patterns are dropped, never coerced', () => {
	const MALFORMED = ['**', '*git', 'g*t', 'a b*', '', ' ', 'tool/name', 'tool@name', '!!', 'a'.repeat(121)];

	it.each(MALFORMED.map((p) => [p]))('drops the whole allow key for the lone entry %s', (pattern) => {
		// A junk entry must NEVER be rounded up to a permissive '*'. Note '**' in
		// this list: it looks like a super-wildcard but is simply invalid here.
		expect(sanitizeToolGrantOverride({ allow: [pattern] })).not.toHaveProperty('allow');
	});

	it.each(MALFORMED.map((p) => [p]))('drops the whole deny key for the lone entry %s', (pattern) => {
		expect(sanitizeToolGrantOverride({ deny: [pattern] })).not.toHaveProperty('deny');
	});
});

describe('sanitizeToolGrantOverride — type filtering', () => {
	it('drops non-string entries before trimming, so no crash', () => {
		expect(sanitizeToolGrantOverride({ allow: [1, null, undefined, {}, [], '*'] } as never)).toEqual({
			allow: ['*']
		});
	});

	it('drops the key when no entry is a string', () => {
		expect(sanitizeToolGrantOverride({ allow: [1, null, {}] } as never)).not.toHaveProperty('allow');
	});

	it('skips a non-array value entirely without disturbing the other field', () => {
		// The loop `continue`s on a non-array, so `allow: '*'` is not treated as a
		// one-character pattern list and `deny` is still processed.
		const out = sanitizeToolGrantOverride({ allow: '*', deny: ['x'] } as never);
		expect(out).toEqual({ deny: ['x'] });
		expect(out).not.toHaveProperty('allow');
	});

	it.each([
		['a string', '*'],
		['null', null],
		['a number', 1],
		['an object', {}]
	])('ignores allow when it is %s rather than an array', (_label, value) => {
		expect(sanitizeToolGrantOverride({ allow: value } as never)).not.toHaveProperty('allow');
	});
});

describe('sanitizeToolGrantOverride — length boundaries', () => {
	it('accepts a 120-character name', () => {
		expect(sanitizeToolGrantOverride({ allow: ['a'.repeat(120)] })).toEqual({ allow: ['a'.repeat(120)] });
	});

	it('accepts a 120-character name plus a trailing star (121 characters total)', () => {
		expect(sanitizeToolGrantOverride({ allow: ['a'.repeat(120) + '*'] })).toEqual({
			allow: ['a'.repeat(120) + '*']
		});
	});

	it('rejects a 121-character name', () => {
		expect(sanitizeToolGrantOverride({ allow: ['a'.repeat(121)] })).not.toHaveProperty('allow');
	});

	it('keeps exactly the two legal entries of a mixed-length list', () => {
		expect(
			sanitizeToolGrantOverride({
				allow: ['a'.repeat(121), 'a'.repeat(120), 'a'.repeat(120) + '*', 'a'.repeat(121) + '*']
			})
		).toEqual({ allow: ['a'.repeat(120), 'a'.repeat(120) + '*'] });
	});
});

describe('sanitizeToolGrantOverride — purity', () => {
	it('never mutates the input object', () => {
		const raw = { allow: ['  git_*  ', 'git_*'], deny: ['bad name'] };
		const before = structuredClone(raw);
		sanitizeToolGrantOverride(raw);
		expect(raw).toEqual(before);
	});

	it('returns fresh arrays that do not alias the caller state', () => {
		const raw = { allow: ['git_*'], deny: ['secret_tool'] };
		const out = sanitizeToolGrantOverride(raw);
		expect(out.allow).not.toBe(raw.allow);
		expect(out.deny).not.toBe(raw.deny);
		expect(out.allow).toEqual(raw.allow);
	});
});

describe('sanitizeToolGrantOverride — output shape', () => {
	it('pins the whole key SET of a fully valid override', () => {
		expect(sanitizeToolGrantOverride({ allow: ['git_*', '*'], deny: ['secret_tool'] })).toEqual({
			allow: ['git_*', '*'],
			deny: ['secret_tool']
		});
	});

	it('emits at most the two known keys', () => {
		const out = sanitizeToolGrantOverride({ allow: ['*'], deny: ['x'], note: 'ignored' } as never);
		expect(Object.keys(out).sort()).toEqual(['allow', 'deny']);
	});
});
