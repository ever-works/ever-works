import { describe, expect, it } from 'vitest';
import { getWorkCapabilities, WORK_KIND_CAPABILITIES, workKindHasItems } from '../work-capabilities.js';
import { normalizeWorkKind, WORK_KINDS, USER_SELECTABLE_WORK_KINDS } from '../work-kind.js';
import { WORK_METRIC_DEFINITIONS } from '../work-metrics.js';

describe('normalizeWorkKind', () => {
	it.each(WORK_KINDS)('passes through the known kind %s', (kind) => {
		expect(normalizeWorkKind(kind)).toBe(kind);
	});

	it('accepts "landing" as an alias for "landing-page"', () => {
		expect(normalizeWorkKind('landing')).toBe('landing-page');
	});

	it('is case- and whitespace-insensitive', () => {
		expect(normalizeWorkKind('  Directory ')).toBe('directory');
		expect(normalizeWorkKind('AWESOME-REPO')).toBe('awesome-repo');
	});

	it.each([
		['an unknown kind from a newer server', 'storefront'],
		['an empty string', ''],
		['whitespace only', '   ']
	])('degrades %s to "default"', (_label, input) => {
		expect(normalizeWorkKind(input)).toBe('default');
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['a number', 42 as unknown as string],
		['an object', {} as unknown as string]
	])('never throws on %s', (_label, input) => {
		expect(() => normalizeWorkKind(input as string | null | undefined)).not.toThrow();
		expect(normalizeWorkKind(input as string | null | undefined)).toBe('default');
	});
});

describe('WORK_KIND_CAPABILITIES', () => {
	/**
	 * The installed-base invariant. Every Work created before the
	 * kind-aware create path carries `kind = 'default'`, so any divergence
	 * here is a silent capability regression for existing customers rather
	 * than a new-kind refinement.
	 */
	it('gives "default" exactly the same capabilities as "directory"', () => {
		expect(WORK_KIND_CAPABILITIES.default).toEqual(WORK_KIND_CAPABILITIES.directory);
	});

	it('covers every kind in WORK_KINDS', () => {
		for (const kind of WORK_KINDS) {
			expect(WORK_KIND_CAPABILITIES[kind]).toBeDefined();
		}
	});

	it('only references metric ids that have a definition', () => {
		for (const kind of WORK_KINDS) {
			for (const metricId of WORK_KIND_CAPABILITIES[kind].metrics) {
				expect(
					WORK_METRIC_DEFINITIONS[metricId],
					`kind "${kind}" references undefined metric "${metricId}"`
				).toBeDefined();
			}
		}
	});

	it('never lists the same metric twice for one kind', () => {
		for (const kind of WORK_KINDS) {
			const metrics = WORK_KIND_CAPABILITIES[kind].metrics;
			expect(new Set(metrics).size, `kind "${kind}" repeats a metric`).toBe(metrics.length);
		}
	});

	it('keeps every kind to a headline-sized tile set', () => {
		for (const kind of WORK_KINDS) {
			const count = WORK_KIND_CAPABILITIES[kind].metrics.length;
			expect(count, `kind "${kind}" has ${count} tiles`).toBeGreaterThanOrEqual(3);
			expect(count, `kind "${kind}" has ${count} tiles`).toBeLessThanOrEqual(6);
		}
	});

	it('always provisions a data repository — it is the source of truth', () => {
		for (const kind of WORK_KINDS) {
			expect(WORK_KIND_CAPABILITIES[kind].repos.data).toBe(true);
		}
	});

	it('does not offer taxonomy-dependent features without taxonomy', () => {
		for (const kind of WORK_KINDS) {
			const caps = WORK_KIND_CAPABILITIES[kind];
			if (caps.comparisons) {
				expect(caps.items.enabled, `kind "${kind}" compares items it cannot have`).toBe(true);
			}
			if (caps.itemImportExport || caps.sourceValidation || caps.communityPr) {
				expect(caps.items.enabled, `kind "${kind}" manages items it cannot have`).toBe(true);
			}
		}
	});

	it('every user-selectable kind is deployable', () => {
		for (const kind of USER_SELECTABLE_WORK_KINDS) {
			expect(WORK_KIND_CAPABILITIES[kind].deploy).toBe(true);
		}
	});
});

describe('getWorkCapabilities', () => {
	it('resolves a known kind', () => {
		expect(getWorkCapabilities('landing-page')).toBe(WORK_KIND_CAPABILITIES['landing-page']);
	});

	it.each([
		['unknown', 'storefront'],
		['undefined', undefined],
		['null', null]
	])('falls back to the default capability set for %s', (_label, input) => {
		expect(getWorkCapabilities(input as string | null | undefined)).toBe(WORK_KIND_CAPABILITIES.default);
	});
});

describe('workKindHasItems', () => {
	it('is true for the directory-shaped kinds and the content kinds', () => {
		expect(workKindHasItems('default')).toBe(true);
		expect(workKindHasItems('directory')).toBe(true);
		expect(workKindHasItems('awesome-repo')).toBe(true);
		expect(workKindHasItems('blog')).toBe(true);
	});

	it('is false where an Items tab would be noise', () => {
		expect(workKindHasItems('landing-page')).toBe(false);
		expect(workKindHasItems('company')).toBe(false);
	});

	it('defaults to true for an unknown kind, so nothing is hidden by accident', () => {
		expect(workKindHasItems('storefront')).toBe(true);
	});
});
