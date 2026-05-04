import { GenerateStatusType } from './generate-status.enum.js';
import { GenerationMethod } from '../generator/generation-method.enum.js';
import type { CreateItemsGeneratorDto } from '../generator/create-items-generator.dto.js';

/**
 * Metrics from a generation run
 */
export interface GenerationMetrics {
	/** Number of URLs scanned */
	urls_scanned?: number;
	/** Number of pages processed */
	pages_processed?: number;
	/** Items extracted in current run */
	items_extracted_current_run?: number;
	/** New items added to store */
	new_items_added_to_store?: number;
	/** Total items in store */
	total_items_in_store?: number;
	/** Total tokens used */
	total_tokens_used?: number;
	/** Total cost */
	total_cost?: number;
}

export enum WorkHistoryActivityType {
	GENERATION = 'generation',
	ITEM_ADDED = 'item_added',
	ITEM_UPDATED = 'item_updated',
	ITEM_REMOVED = 'item_removed',
	COMPARISON_ADDED = 'comparison_added',
	COMPARISON_REMOVED = 'comparison_removed',
	CATEGORY_CHANGE = 'category_change',
	TAG_CHANGE = 'tag_change',
	COLLECTION_CHANGE = 'collection_change',
	COMMUNITY_PR_MERGED = 'community_pr_merged'
}

export type WorkHistoryChangeEntityType = 'item' | 'comparison' | 'category' | 'tag' | 'collection';

export type WorkHistoryChangeAction = 'added' | 'updated' | 'removed';

export interface WorkHistoryChangeEntry {
	entityType: WorkHistoryChangeEntityType;
	action: WorkHistoryChangeAction;
	name: string;
	slug?: string;
	fieldsChanged?: string[];
}

// ── Generation Step Logs ───────────────────────────────────────────────

export type GenerationLogLevel = 'info' | 'warn' | 'error' | 'debug';
export type GenerationLogSource = 'pipeline' | 'orchestrator' | 'claude-code' | 'system';

export interface GenerationStepLog {
	timestamp: string;
	level: GenerationLogLevel;
	source: GenerationLogSource;
	stepIndex?: number | null;
	stepName?: string | null;
	event: 'step_started' | 'step_completed' | 'step_failed' | 'step_skipped' | 'message';
	message: string;
	durationMs?: number | null;
}

export interface WorkChangelog {
	summary?: string | null;
	addedCount: number;
	updatedCount: number;
	removedCount: number;
	entries: WorkHistoryChangeEntry[];
}

/**
 * Entry in work generation history
 */
export interface WorkGenerationHistoryEntry {
	/** History entry ID */
	id: string;
	/** Generation status */
	status: GenerateStatusType;
	/** Generation method used */
	generationMethod?: GenerationMethod | null;
	/** When generation started (ISO string) */
	startedAt?: string | null;
	/** When generation finished (ISO string) */
	finishedAt?: string | null;
	/** Duration in seconds */
	durationInSeconds?: number | null;
	/** Number of new items */
	newItemsCount: number;
	/** Number of updated items */
	updatedItemsCount: number;
	/** Total items count */
	totalItemsCount: number;
	/** Generation metrics */
	metrics?: GenerationMetrics | null;
	/** Error message if failed */
	errorMessage?: string | null;
	/** Generation parameters used */
	parameters?: CreateItemsGeneratorDto | null;
	/** Created timestamp (ISO string) */
	createdAt: string;
	/** Updated timestamp (ISO string) */
	updatedAt: string;
	/** Trigger.dev run ID */
	triggerRunId?: string;
	/** History activity type */
	activityType: WorkHistoryActivityType;
	/** Structured changelog details */
	changelog?: WorkChangelog | null;
	/** Step-level generation logs */
	logs?: GenerationStepLog[] | null;
	/** Warnings captured during generation */
	warnings?: string[] | null;
	/** What triggered this run */
	triggeredBy?: 'user' | 'schedule' | 'api' | null;
}

/**
 * Response for work generation history
 */
export interface WorkGenerationHistoryResponse {
	/** History entries */
	history: WorkGenerationHistoryEntry[];
	/** Total count */
	total: number;
	/** Pagination limit */
	limit: number;
	/** Pagination offset */
	offset: number;
}
