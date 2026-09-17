/**
 * Playbook catalogue (AW-21) — what the API returns about a playbook FOR A
 * GIVEN CALLER: whether this workspace can run it right now, what is missing,
 * and what setting it up would create.
 *
 * Readiness is computed per request from plugin state and is never stored.
 */

import type {
	PlaybookCatalogEntry,
	PlaybookCategory,
	PlaybookCostBand,
	PlaybookTokenEstimate,
	PlaybookTriggerKind
} from './playbook-catalog.types.js';

/** Readiness is exactly one of these four states. */
export const PLAYBOOK_READINESS_STATES = ['ready', 'needs_connection', 'blocked', 'adopted'] as const;
export type PlaybookReadinessState = (typeof PLAYBOOK_READINESS_STATES)[number];

/** The non-connection reasons a playbook cannot be set up. */
export const PLAYBOOK_BLOCKER_CODES = ['adoption_ceiling', 'copy_limit', 'no_edit_access'] as const;
export type PlaybookBlockerCode = (typeof PLAYBOOK_BLOCKER_CODES)[number];

/** A readiness answer is served from cache for at most this long. */
export const PLAYBOOK_READINESS_CACHE_MS = 60_000;

/**
 * The merged catalogue is served from cache for at most this long per caller.
 * Which providers are enabled differs per caller and can change at any time,
 * so the catalogue is never cached longer than readiness is.
 */
export const PLAYBOOK_CATALOG_CACHE_MS = 60_000;

/** Readiness checks still unresolved after this budget are reported as `unknown`. */
export const PLAYBOOK_READINESS_BUDGET_MS = 2_000;

/** Which enabled plugin satisfies a capability, as display data resolved from the registry. */
export interface PlaybookCapabilityProvider {
	readonly pluginId: string;
	readonly name: string;
}

export interface PlaybookConnectionStatus {
	readonly capability: string;
	readonly required: boolean;
	readonly reason: string;
	readonly degradedWithout?: string;
	/** `null` when no enabled plugin in this scope provides the capability. */
	readonly satisfiedBy: PlaybookCapabilityProvider | null;
}

export interface PlaybookBlocker {
	readonly code: PlaybookBlockerCode;
	readonly currentCount: number;
	readonly limit: number;
}

export interface PlaybookNameCollision {
	readonly type: 'agent_name';
	readonly requested: string;
	readonly suggested: string;
}

export interface PlaybookReadiness {
	readonly state: PlaybookReadinessState;
	readonly connections: readonly PlaybookConnectionStatus[];
	/** Capability names of every required connection nothing enabled provides. */
	readonly missingRequired: readonly string[];
	readonly blockers: readonly PlaybookBlocker[];
	readonly collisions: readonly PlaybookNameCollision[];
	/** Checks that did not resolve inside the readiness budget. */
	readonly unknown: readonly string[];
}

/** The row types a playbook's setup would create. */
export const PLAYBOOK_PLAN_ITEM_TYPES = [
	'agent',
	'skills',
	'task_template',
	'guardrails',
	'schedule',
	'inbound_trigger',
	'workflow'
] as const;
export type PlaybookPlanItemType = (typeof PLAYBOOK_PLAN_ITEM_TYPES)[number];

export interface PlaybookPlanItem {
	readonly type: PlaybookPlanItemType;
	/** How many rows of this type would be created (0 for guardrails, which edit the created Agent). */
	readonly count: number;
	/** The name(s) the created rows get. */
	readonly names: readonly string[];
	/** Short structured detail, e.g. step counts or the cadence. */
	readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/** The itemised list of what setting a playbook up would create — one source for the sheet and the executor. */
export interface PlaybookAdoptionPlan {
	readonly slug: string;
	readonly version: string;
	readonly instanceName: string;
	readonly items: readonly PlaybookPlanItem[];
	/** SHA-256 hex of the plan, so a confirm can prove it saw this exact plan. */
	readonly planHash: string;
}

export interface PlaybookPreflightReport extends PlaybookReadiness {
	readonly plan: PlaybookAdoptionPlan;
}

/** The card-sized view of a playbook plus the caller's readiness. */
export interface PlaybookSummary {
	readonly slug: string;
	readonly title: string;
	readonly outcome: string;
	readonly summary: string;
	readonly category: PlaybookCategory;
	readonly version: string;
	readonly icon: string;
	readonly triggerKind: PlaybookTriggerKind;
	readonly triggerDescription: string;
	readonly costBand: PlaybookCostBand;
	readonly estimatedTokensPerRun: PlaybookTokenEstimate;
	readonly tags: readonly string[];
	readonly stepTitles: readonly string[];
	readonly requiredCapabilities: readonly string[];
	readonly readiness: PlaybookReadinessState;
	readonly missingRequired: readonly string[];
}

export interface PlaybookListResponse {
	readonly items: readonly PlaybookSummary[];
	readonly total: number;
}

export interface PlaybookDetailResponse {
	readonly entry: PlaybookCatalogEntry;
	readonly readiness: PlaybookReadiness;
}
