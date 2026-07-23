/**
 * Per-Work-kind metric vocabulary.
 *
 * A Work's headline statistics depend on what the Work *is*: counting
 * "Total Items" on a landing page is noise, and counting "Comparisons" on a
 * blog is meaningless. The kind → metric mapping lives in
 * `work-capabilities.ts`; this module defines the metrics themselves.
 *
 * Definitions are data, not components — `@ever-works/contracts` is
 * framework-free and must stay importable from the API, the agent package
 * and the web app alike. The web app maps `WorkMetricDefinition.id` to a
 * Lucide icon in its own presentation layer.
 */

/** Every metric the platform can render on a Work. */
export const WORK_METRIC_IDS = [
	// Content counts — denormalized columns on the Work row.
	'total-items',
	'posts',
	'categories',
	'tags',
	'comparisons',
	// Lifecycle — derived from columns already on the Work.
	'generation-status',
	'deploy-status',
	'days-active',
	// Cheap DB counts.
	'registered-users',
	'team-members',
	'agents',
	'open-tasks',
	'works-owned',
	// Provider-backed analytics. Resolvable only once an analytics provider
	// is connected to the Work; until then they report `not_configured`.
	'page-views',
	'sessions',
	'conversions'
] as const;

export type WorkMetricId = (typeof WORK_METRIC_IDS)[number];

/**
 * Where a metric's value comes from. Drives which resolver runs and, when
 * the value is unavailable, which remediation hint the UI offers.
 */
export type WorkMetricSource =
	/** Read straight off the Work row — always available. */
	| 'work-column'
	/** Computed from Work columns (e.g. days since creation). */
	| 'derived'
	/** A cheap `COUNT(*)` against a table the platform owns. */
	| 'db-count'
	/** Supplied by a connected metrics-provider plugin. */
	| 'provider';

/** How the raw number should be presented. */
export type WorkMetricFormat = 'integer' | 'percent' | 'duration-days' | 'status';

/**
 * Message keys under `dashboard.workDetail.stats`.
 *
 * A literal union rather than `string`: the web app looks these up through
 * next-intl, whose `useTranslations` type-checks keys against the message
 * catalogue at compile time. Widening this to `string` would silently opt
 * every tile label out of that check.
 */
export type WorkMetricLabelKey =
	| 'totalItems'
	| 'posts'
	| 'categories'
	| 'tags'
	| 'comparisons'
	| 'generationStatus'
	| 'deployStatus'
	| 'daysActive'
	| 'registeredUsers'
	| 'teamMembers'
	| 'agents'
	| 'openTasks'
	| 'worksOwned'
	| 'pageViews'
	| 'sessions'
	| 'conversions';

export interface WorkMetricDefinition {
	readonly id: WorkMetricId;
	/**
	 * Key under `dashboard.workDetail.stats` in the web app's messages.
	 * Kept as a key rather than a label so contracts stays locale-free.
	 */
	readonly labelKey: WorkMetricLabelKey;
	readonly source: WorkMetricSource;
	readonly format: WorkMetricFormat;
}

/**
 * The resolution state of a single metric.
 *
 * Distinguishing these from a plain `0` is the whole point: a Website Work
 * that has never had analytics connected has *unknown* page views, not zero
 * page views, and showing "0" reads as a broken product.
 */
export type WorkMetricState =
	| 'ok'
	/** No analytics/metrics provider is connected to this Work yet. */
	| 'not_configured'
	/** Metric needs a deployment that does not exist yet. */
	| 'not_deployed'
	/** Metric needs content generation that has not run yet. */
	| 'not_generated'
	/** Resolution failed. Never fatal — the tile degrades, the page renders. */
	| 'error';

export interface WorkMetricValue {
	readonly id: WorkMetricId;
	readonly state: WorkMetricState;
	/** Present only when `state === 'ok'`. */
	readonly value?: number | string;
	/**
	 * Change versus the previous comparable period, as a signed ratio
	 * (`0.12` = +12%). Omitted when a comparison is unavailable or would be
	 * expensive.
	 */
	readonly delta?: number;
}

export const WORK_METRIC_DEFINITIONS: Record<WorkMetricId, WorkMetricDefinition> = {
	'total-items': {
		id: 'total-items',
		labelKey: 'totalItems',
		source: 'work-column',
		format: 'integer'
	},
	posts: {
		id: 'posts',
		labelKey: 'posts',
		source: 'work-column',
		format: 'integer'
	},
	categories: {
		id: 'categories',
		labelKey: 'categories',
		source: 'work-column',
		format: 'integer'
	},
	tags: {
		id: 'tags',
		labelKey: 'tags',
		source: 'work-column',
		format: 'integer'
	},
	comparisons: {
		id: 'comparisons',
		labelKey: 'comparisons',
		source: 'work-column',
		format: 'integer'
	},
	'generation-status': {
		id: 'generation-status',
		labelKey: 'generationStatus',
		source: 'derived',
		format: 'status'
	},
	'deploy-status': {
		id: 'deploy-status',
		labelKey: 'deployStatus',
		source: 'derived',
		format: 'status'
	},
	'days-active': {
		id: 'days-active',
		labelKey: 'daysActive',
		source: 'derived',
		format: 'duration-days'
	},
	'registered-users': {
		id: 'registered-users',
		labelKey: 'registeredUsers',
		source: 'db-count',
		format: 'integer'
	},
	'team-members': {
		id: 'team-members',
		labelKey: 'teamMembers',
		source: 'db-count',
		format: 'integer'
	},
	agents: {
		id: 'agents',
		labelKey: 'agents',
		source: 'db-count',
		format: 'integer'
	},
	'open-tasks': {
		id: 'open-tasks',
		labelKey: 'openTasks',
		source: 'db-count',
		format: 'integer'
	},
	'works-owned': {
		id: 'works-owned',
		labelKey: 'worksOwned',
		source: 'db-count',
		format: 'integer'
	},
	'page-views': {
		id: 'page-views',
		labelKey: 'pageViews',
		source: 'provider',
		format: 'integer'
	},
	sessions: {
		id: 'sessions',
		labelKey: 'sessions',
		source: 'provider',
		format: 'integer'
	},
	conversions: {
		id: 'conversions',
		labelKey: 'conversions',
		source: 'provider',
		format: 'integer'
	}
};

/** Definition lookup that tolerates an unknown id from a newer server. */
export function getWorkMetricDefinition(id: string): WorkMetricDefinition | undefined {
	return WORK_METRIC_DEFINITIONS[id as WorkMetricId];
}
