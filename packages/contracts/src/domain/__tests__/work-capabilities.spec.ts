import { describe, expect, it } from 'vitest';
import { getWorkCapabilities, WORK_KIND_CAPABILITIES, workKindHasItems } from '../work-capabilities.js';
import {
	isAppWorkKind,
	isRepositoryWorkKind,
	isUserSelectableWorkKind,
	normalizeWorkKind,
	WORK_KINDS,
	USER_SELECTABLE_WORK_KINDS,
	type WorkKind
} from '../work-kind.js';
import { WORK_METRIC_DEFINITIONS } from '../work-metrics.js';

/**
 * True when the kind's `website`-role repository holds a GENERATED website —
 * template output the platform produced and then deploys.
 *
 * The role name alone does not answer that any more: `app` provisions the
 * `website` role too, but its Work Repository holds the app code the member
 * linked, forked or copied (FR-2 / README D1), which is exactly what
 * `builds` records. `repo` is the other kind that generates nothing — it has
 * no website role at all. Reading the two flags together is what keeps the
 * deploy invariants below honest for both of them.
 */
function generatesWebsite(kind: WorkKind): boolean {
	const caps = WORK_KIND_CAPABILITIES[kind];
	return caps.repos.website && !caps.builds;
}

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

	it('always provisions a data repository — it is the source of truth (every kind except "app")', () => {
		for (const kind of WORK_KINDS) {
			// `app` is the deliberate exception (FR-2): its Work Repository is
			// the app code itself, and it never provisions the `data` role.
			// Asserted positively in its own test below.
			if (kind === 'app') {
				continue;
			}
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

	it('only "repo" and "app" lack a website repository the platform generates', () => {
		const withoutWebsite = USER_SELECTABLE_WORK_KINDS.filter((kind) => !generatesWebsite(kind));
		expect(withoutWebsite).toEqual(['repo', 'app']);
	});

	it('a kind without a website repository to generate deploys only when it is "app"', () => {
		for (const kind of WORK_KINDS) {
			if (generatesWebsite(kind)) {
				continue;
			}
			const caps = WORK_KIND_CAPABILITIES[kind];
			expect(caps.deploy, `kind "${kind}" deploys without a website repo`).toBe(kind === 'app');
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

/**
 * The App kind (APW-01, README D1) — a Work whose Work Repository is an
 * existing GitHub repository the member linked, forked or copied, and which
 * the platform builds, runs and evolves.
 */
describe('the app work kind', () => {
	it('is a known, user-selectable kind that no longer degrades to "default"', () => {
		expect(normalizeWorkKind('app')).toBe('app');
		expect(normalizeWorkKind('APP ')).toBe('app');
		expect(isUserSelectableWorkKind('app')).toBe(true);
		expect(USER_SELECTABLE_WORK_KINDS as readonly string[]).toContain('app');
		expect(WORK_KINDS as readonly string[]).toContain('app');
	});

	it('does not collide with the repo kind', () => {
		expect(normalizeWorkKind('repo')).toBe('repo');
		expect(WORK_KIND_CAPABILITIES.app).not.toEqual(WORK_KIND_CAPABILITIES.repo);
	});

	it('has deploy, the knowledge base, builds and the App environment on', () => {
		const caps = WORK_KIND_CAPABILITIES.app;
		expect(caps.deploy).toBe(true);
		expect(caps.kb).toBe(true);
		expect(caps.builds).toBe(true);
		expect(caps.appEnvironment).toBe(true);
	});

	it('has nothing item-shaped on — the app code is not generated content', () => {
		const caps = WORK_KIND_CAPABILITIES.app;
		expect(caps.items.enabled).toBe(false);
		expect(caps.taxonomy).toBe(false);
		expect(caps.comparisons).toBe(false);
		expect(caps.communityPr).toBe(false);
		expect(caps.itemImportExport).toBe(false);
		expect(caps.sourceValidation).toBe(false);
	});

	it('provisions exactly one repository role — the Work Repository (persisted `website`)', () => {
		// FR-2: the app-code fork IS the Work Repository, and the `data` role
		// (which holds a Work's data) is never provisioned for this kind.
		expect(WORK_KIND_CAPABILITIES.app.repos).toEqual({ data: false, work: false, website: true });
	});

	it('maps to metrics that describe the app being run', () => {
		expect(WORK_KIND_CAPABILITIES.app.metrics).toEqual(['agents', 'open-tasks', 'deploy-status', 'days-active']);
	});

	it('resolves through getWorkCapabilities like every other kind', () => {
		expect(getWorkCapabilities('app')).toBe(WORK_KIND_CAPABILITIES.app);
		expect(getWorkCapabilities('APP ')).toBe(WORK_KIND_CAPABILITIES.app);
	});

	it('isAppWorkKind recognises only the app kind, with the same loose input as normalizeWorkKind', () => {
		expect(isAppWorkKind('app')).toBe(true);
		expect(isAppWorkKind('  APP ')).toBe(true);
		// The kinds that merely contain the word must not match.
		expect(isAppWorkKind('application')).toBe(false);
		expect(isAppWorkKind('repo')).toBe(false);
		expect(isAppWorkKind('awesome-repo')).toBe(false);
		for (const kind of WORK_KINDS.filter((k) => k !== 'app')) {
			expect(isAppWorkKind(kind), `kind "${kind}"`).toBe(false);
		}
		expect(isAppWorkKind(undefined)).toBe(false);
		expect(isAppWorkKind(null)).toBe(false);
		expect(isAppWorkKind('')).toBe(false);
	});
});

/**
 * The two capability flags Resolution R-7 adds: `builds` (APW-05's Builds
 * surface) and `appEnvironment` (APW-07's App env / dependencies surfaces).
 * Both exist so those epics read the registry instead of testing
 * `kind === 'app'` inline, and both are on for `app` ONLY.
 */
describe('the builds and appEnvironment capability flags (R-7)', () => {
	it.each(WORK_KINDS.filter((kind) => kind !== 'app'))('keeps both flags off for the %s kind', (kind) => {
		const caps = WORK_KIND_CAPABILITIES[kind];
		expect(caps.builds, `kind "${kind}" claims a Builds surface`).toBe(false);
		expect(caps.appEnvironment, `kind "${kind}" claims an App environment`).toBe(false);
	});

	it('turns both flags on for "app", and for no other kind', () => {
		expect(WORK_KIND_CAPABILITIES.app.builds).toBe(true);
		expect(WORK_KIND_CAPABILITIES.app.appEnvironment).toBe(true);

		const withBuilds = WORK_KINDS.filter((kind) => WORK_KIND_CAPABILITIES[kind].builds);
		const withAppEnvironment = WORK_KINDS.filter((kind) => WORK_KIND_CAPABILITIES[kind].appEnvironment);
		expect(withBuilds).toEqual(['app']);
		expect(withAppEnvironment).toEqual(['app']);
	});

	it('keeps both flags off for an unknown kind that falls back to the default set', () => {
		expect(getWorkCapabilities('storefront').builds).toBe(false);
		expect(getWorkCapabilities('storefront').appEnvironment).toBe(false);
		expect(getWorkCapabilities(undefined).builds).toBe(false);
		expect(getWorkCapabilities(null).appEnvironment).toBe(false);
	});
});
