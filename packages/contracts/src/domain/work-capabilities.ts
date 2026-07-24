import { normalizeWorkKind, type WorkKind } from './work-kind.js';
import type { WorkMetricId } from './work-metrics.js';

/**
 * What a Work of a given kind actually has.
 *
 * Before this registry, "given `work.kind`, what does this Work support?"
 * was answered independently in half a dozen places — the create-page chip
 * catalogs, the website-template resolver, and (mostly) nowhere at all,
 * because every surface simply assumed a directory. That is why a Landing
 * Page Work shows an Items tab and a "Total Items: 0" tile.
 *
 * Every kind-conditional decision in the platform should route through
 * `getWorkCapabilities()` rather than testing `kind === 'directory'` inline.
 */
export interface WorkCapabilities {
	/**
	 * The Items surface: the Items tab, the `/items` routes, and the
	 * submission / import / export endpoints that operate on them.
	 * `labelKey` lets a kind keep the machinery but rename it — a blog's
	 * items are "posts", a website's are "pages".
	 */
	readonly items: { readonly enabled: boolean; readonly labelKey: 'items' | 'posts' | 'pages' };
	/** Categories / tags / collections CRUD and their tiles. */
	readonly taxonomy: boolean;
	/** The comparison generator sub-tab and its endpoints. */
	readonly comparisons: boolean;
	/** Community pull-request intake settings and processing. */
	readonly communityPr: boolean;
	/** Bulk item import / export. */
	readonly itemImportExport: boolean;
	/** Source-URL validation for items. */
	readonly sourceValidation: boolean;
	/** The Deploy tab and deployment endpoints. */
	readonly deploy: boolean;
	/** The knowledge-base workbench. */
	readonly kb: boolean;
	/** Ordered metric tiles rendered on the Overview tab. */
	readonly metrics: readonly WorkMetricId[];
	/**
	 * Which repositories this kind provisions.
	 *
	 * ⚠️ These keys are the PERSISTED `RepositoryRole` values and must not
	 * be renamed to match the newer UI labels. Mapping, for the avoidable
	 * confusion it saves: `data` → "Data Repository", `work` → the
	 * "{provider} Repository" shown to users, `website` → the "Work
	 * Repository" (the template output, which is not always a website).
	 */
	readonly repos: { readonly data: boolean; readonly work: boolean; readonly website: boolean };
}

/**
 * Capability set for the directory-shaped kinds.
 *
 * `default` and `directory` MUST share this object. Every Work created
 * before the kind-aware create path carries `kind = 'default'` — that is
 * effectively the entire installed base, plus every Work the e2e helpers
 * create. Giving `default` a reduced capability set would be a silent,
 * platform-wide feature regression for existing customers. This registry is
 * a hide-list for the new kinds, never an allow-list for the old ones.
 */
const DIRECTORY_CAPABILITIES: WorkCapabilities = {
	items: { enabled: true, labelKey: 'items' },
	taxonomy: true,
	comparisons: true,
	communityPr: true,
	itemImportExport: true,
	sourceValidation: true,
	deploy: true,
	kb: true,
	metrics: ['total-items', 'categories', 'comparisons', 'generation-status', 'days-active'],
	repos: { data: true, work: true, website: true }
};

export const WORK_KIND_CAPABILITIES: Record<WorkKind, WorkCapabilities> = {
	default: DIRECTORY_CAPABILITIES,
	directory: DIRECTORY_CAPABILITIES,

	// An awesome list is a curated index: it has items and taxonomy, but
	// head-to-head comparisons are a directory-only affordance.
	'awesome-repo': {
		items: { enabled: true, labelKey: 'items' },
		taxonomy: true,
		comparisons: false,
		communityPr: true,
		itemImportExport: true,
		sourceValidation: true,
		deploy: true,
		kb: true,
		metrics: ['total-items', 'categories', 'tags', 'generation-status', 'days-active'],
		repos: { data: true, work: true, website: true }
	},

	blog: {
		items: { enabled: true, labelKey: 'posts' },
		taxonomy: true,
		comparisons: false,
		communityPr: false,
		itemImportExport: false,
		sourceValidation: false,
		deploy: true,
		kb: true,
		metrics: ['posts', 'page-views', 'registered-users', 'deploy-status', 'days-active'],
		repos: { data: true, work: true, website: true }
	},

	website: {
		items: { enabled: true, labelKey: 'pages' },
		taxonomy: false,
		comparisons: false,
		communityPr: false,
		itemImportExport: false,
		sourceValidation: false,
		deploy: true,
		kb: true,
		metrics: ['page-views', 'registered-users', 'sessions', 'deploy-status', 'generation-status'],
		repos: { data: true, work: true, website: true }
	},

	'landing-page': {
		items: { enabled: false, labelKey: 'pages' },
		taxonomy: false,
		comparisons: false,
		communityPr: false,
		itemImportExport: false,
		sourceValidation: false,
		deploy: true,
		kb: true,
		metrics: ['page-views', 'conversions', 'deploy-status', 'days-active'],
		repos: { data: true, work: true, website: true }
	},

	// A Company Work is an organizational shell, not a generated site: it
	// backs an Organization rather than producing deployable output.
	company: {
		items: { enabled: false, labelKey: 'items' },
		taxonomy: false,
		comparisons: false,
		communityPr: false,
		itemImportExport: false,
		sourceValidation: false,
		deploy: false,
		kb: true,
		metrics: ['works-owned', 'team-members', 'agents', 'open-tasks', 'days-active'],
		repos: { data: true, work: true, website: false }
	}
};

/**
 * Capabilities for a possibly-unknown kind.
 *
 * ALWAYS use this instead of indexing `WORK_KIND_CAPABILITIES` directly.
 * `work.kind` is an open string union — a server can ship a kind this build
 * has never heard of, and indexing would hand back `undefined` and crash
 * whatever destructured it.
 */
export function getWorkCapabilities(kind?: string | null): WorkCapabilities {
	return WORK_KIND_CAPABILITIES[normalizeWorkKind(kind)] ?? WORK_KIND_CAPABILITIES.default;
}

/** Convenience predicate — the Items tab / routes are meaningful here. */
export function workKindHasItems(kind?: string | null): boolean {
	return getWorkCapabilities(kind).items.enabled;
}
