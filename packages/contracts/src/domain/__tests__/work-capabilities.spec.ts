import { describe, expect, it } from 'vitest';
import { getWorkCapabilities, WORK_KIND_CAPABILITIES, workKindHasItems } from '../work-capabilities.js';
import {
	isRepositoryWorkKind,
	isUserSelectableWorkKind,
	normalizeWorkKind,
	WORK_KINDS,
	USER_SELECTABLE_WORK_KINDS
} from '../work-kind.js';
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

	it('every user-selectable kind that provisions a website repository is deployable', () => {
		for (const kind of USER_SELECTABLE_WORK_KINDS) {
			const caps = WORK_KIND_CAPABILITIES[kind];
			if (caps.repos.website) {
				expect(caps.deploy, `kind "${kind}" has a website repo but no deploy`).toBe(true);
			}
		}
	});

	it('keeps "repo" the only user-selectable kind without a website repository', () => {
		const withoutWebsite = USER_SELECTABLE_WORK_KINDS.filter((kind) => !WORK_KIND_CAPABILITIES[kind].repos.website);
		expect(withoutWebsite).toEqual(['repo']);
	});

	it('never deploys a kind that has no website repository to deploy', () => {
		for (const kind of WORK_KINDS) {
			const caps = WORK_KIND_CAPABILITIES[kind];
			if (!caps.repos.website) {
				expect(caps.deploy, `kind "${kind}" deploys without a website repo`).toBe(false);
			}
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
		expect(workKindHasItems('campaign')).toBe(false);
		expect(workKindHasItems('repo')).toBe(false);
	});

	it('defaults to true for an unknown kind, so nothing is hidden by accident', () => {
		expect(workKindHasItems('storefront')).toBe(true);
	});
});

/**
 * The go-to-market campaign kind — the artifact home for what a go-to-market
 * pipeline produces (lead lists, drafts awaiting the review gate, reports).
 */
describe('the campaign work kind', () => {
	it('is a known kind that no longer degrades to "default"', () => {
		expect(normalizeWorkKind('campaign')).toBe('campaign');
		expect(normalizeWorkKind('  CAMPAIGN ')).toBe('campaign');
	});

	it('stays out of the create-path chip catalog, like company', () => {
		expect(USER_SELECTABLE_WORK_KINDS as readonly string[]).not.toContain('campaign');
		expect(WORK_KINDS as readonly string[]).toContain('campaign');
	});

	it('is a non-deployable, non-taxonomy shell with the knowledge base on', () => {
		const caps = WORK_KIND_CAPABILITIES.campaign;
		expect(caps.items.enabled).toBe(false);
		expect(caps.taxonomy).toBe(false);
		expect(caps.comparisons).toBe(false);
		expect(caps.communityPr).toBe(false);
		expect(caps.deploy).toBe(false);
		expect(caps.kb).toBe(true);
		expect(caps.repos.website).toBe(false);
	});

	it('maps to metrics that describe campaign effort and outcome', () => {
		expect(WORK_KIND_CAPABILITIES.campaign.metrics).toEqual(['agents', 'open-tasks', 'conversions', 'days-active']);
	});
});

/**
 * The Repository kind (self-build slice D, EW-766) — an existing code
 * repository registered as a first-class Work so Tasks, Goals and fleet
 * runs can attach to it. The data repository IS the code repository.
 */
describe('the repo work kind', () => {
	it('is a known, user-selectable kind that no longer degrades to "default"', () => {
		expect(normalizeWorkKind('repo')).toBe('repo');
		expect(normalizeWorkKind('  REPO ')).toBe('repo');
		expect(isUserSelectableWorkKind('repo')).toBe(true);
		expect(isUserSelectableWorkKind(' Repo ')).toBe(true);
		expect(USER_SELECTABLE_WORK_KINDS as readonly string[]).toContain('repo');
		expect(WORK_KINDS as readonly string[]).toContain('repo');
	});

	it('does not collide with the awesome-repo kind', () => {
		expect(normalizeWorkKind('awesome-repo')).toBe('awesome-repo');
		expect(WORK_KIND_CAPABILITIES.repo).not.toEqual(WORK_KIND_CAPABILITIES['awesome-repo']);
	});

	it('has no items, taxonomy, deploy or generated repositories — only the data (code) repo and the KB', () => {
		const caps = WORK_KIND_CAPABILITIES.repo;
		expect(caps.items.enabled).toBe(false);
		expect(caps.taxonomy).toBe(false);
		expect(caps.comparisons).toBe(false);
		expect(caps.communityPr).toBe(false);
		expect(caps.itemImportExport).toBe(false);
		expect(caps.sourceValidation).toBe(false);
		expect(caps.deploy).toBe(false);
		expect(caps.kb).toBe(true);
		expect(caps.repos).toEqual({ data: true, work: false, website: false });
	});

	it('maps to metrics that describe the work happening on the repository', () => {
		expect(WORK_KIND_CAPABILITIES.repo.metrics).toEqual(['agents', 'open-tasks', 'days-active']);
	});

	it('resolves through getWorkCapabilities like every other kind', () => {
		expect(getWorkCapabilities('repo')).toBe(WORK_KIND_CAPABILITIES.repo);
		expect(getWorkCapabilities('REPO')).toBe(WORK_KIND_CAPABILITIES.repo);
	});

	it('isRepositoryWorkKind recognises only the repo kind, with the same loose input as normalizeWorkKind', () => {
		expect(isRepositoryWorkKind('repo')).toBe(true);
		expect(isRepositoryWorkKind('  REPO ')).toBe(true);
		// The kind that merely contains the word must not match — its data
		// repository is platform-generated and the pipelines are welcome there.
		expect(isRepositoryWorkKind('awesome-repo')).toBe(false);
		for (const kind of WORK_KINDS.filter((k) => k !== 'repo')) {
			expect(isRepositoryWorkKind(kind), `kind "${kind}"`).toBe(false);
		}
		expect(isRepositoryWorkKind(undefined)).toBe(false);
		expect(isRepositoryWorkKind(null)).toBe(false);
		expect(isRepositoryWorkKind('')).toBe(false);
		expect(isRepositoryWorkKind('repository')).toBe(false);
	});
});
