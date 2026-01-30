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

/**
 * Entry in directory generation history
 */
export interface DirectoryGenerationHistoryEntry {
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
}

/**
 * Response for directory generation history
 */
export interface DirectoryGenerationHistoryResponse {
	/** History entries */
	history: DirectoryGenerationHistoryEntry[];
	/** Total count */
	total: number;
	/** Pagination limit */
	limit: number;
	/** Pagination offset */
	offset: number;
}
