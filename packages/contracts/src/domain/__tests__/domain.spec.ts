import { describe, it, expect } from 'vitest';
import {
	DomainType,
	isAppWorkKind,
	isRepositoryWorkKind,
	isUserSelectableWorkKind,
	normalizeWorkKind,
	USER_SELECTABLE_WORK_KINDS,
	WORK_KINDS
} from '../index.js';

describe('DomainType enum', () => {
	it('exposes the four expected string values', () => {
		expect(DomainType.SOFTWARE).toBe('software');
		expect(DomainType.ECOMMERCE).toBe('ecommerce');
		expect(DomainType.SERVICES).toBe('services');
		expect(DomainType.GENERAL).toBe('general');
	});

	it('has exactly 4 members (catches accidental additions/removals)', () => {
		// String enums emit one entry per member; no reverse-mapping noise.
		expect(Object.keys(DomainType)).toEqual(
			expect.arrayContaining(['SOFTWARE', 'ECOMMERCE', 'SERVICES', 'GENERAL'])
		);
		expect(Object.keys(DomainType)).toHaveLength(4);
	});
});

/**
 * The App kind (APW-01 T1, README D1) — appended to the selectable
 * vocabulary after `repo`, so nothing that already existed moves.
 */
describe('the app work kind', () => {
	it('normalizes loose input to "app"', () => {
		expect(normalizeWorkKind('app')).toBe('app');
		expect(normalizeWorkKind('APP ')).toBe('app');
		expect(normalizeWorkKind('  App  ')).toBe('app');
	});

	it('is a known kind rather than a value that degrades to "default"', () => {
		expect(WORK_KINDS as readonly string[]).toContain('app');
		expect(USER_SELECTABLE_WORK_KINDS as readonly string[]).toContain('app');
		expect(isUserSelectableWorkKind('app')).toBe(true);
	});

	it('is appended after "repo" — every pre-existing kind keeps its position', () => {
		expect([...USER_SELECTABLE_WORK_KINDS]).toEqual([
			'website',
			'landing-page',
			'blog',
			'directory',
			'awesome-repo',
			'repo',
			'app'
		]);
		// The three platform-minted kinds still follow, in their own order.
		expect([...WORK_KINDS]).toEqual([...USER_SELECTABLE_WORK_KINDS, 'company', 'campaign', 'default']);
	});

	it('isAppWorkKind accepts only the app kind, with the same loose input as normalizeWorkKind', () => {
		expect(isAppWorkKind('app')).toBe(true);
		expect(isAppWorkKind('  APP ')).toBe(true);
		expect(isAppWorkKind('application')).toBe(false);
		expect(isAppWorkKind('apps')).toBe(false);
		expect(isAppWorkKind('repo')).toBe(false);
		expect(isAppWorkKind('awesome-repo')).toBe(false);
		expect(isAppWorkKind('default')).toBe(false);
		expect(isAppWorkKind('app-fork')).toBe(false);
		expect(isAppWorkKind('')).toBe(false);
		expect(isAppWorkKind(undefined)).toBe(false);
		expect(isAppWorkKind(null)).toBe(false);
		expect(isAppWorkKind(42 as unknown as string)).toBe(false);
		expect(isAppWorkKind({} as unknown as string)).toBe(false);
	});

	it('never confuses the app kind with the repository kind', () => {
		for (const kind of WORK_KINDS) {
			expect(isAppWorkKind(kind), `kind "${kind}"`).toBe(kind === 'app');
			expect(isRepositoryWorkKind(kind), `kind "${kind}"`).toBe(kind === 'repo');
		}
	});
});
