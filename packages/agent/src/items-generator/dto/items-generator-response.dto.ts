import { CreateItemsGeneratorDto } from './create-items-generator.dto';

export interface ItemsGeneratorMetrics {
    urls_scanned: number;
    pages_processed: number;
    items_extracted_current_run: number;
    new_items_added_to_store: number;
    total_items_in_store: number;
    total_tokens_used?: number;
    total_cost?: number;
    // total_categories_in_store: number;
    // total_tags_in_store: number;
}

export interface ItemsGeneratorResponseDto {
    status: 'success' | 'error' | 'pending' | 'skipped';
    slug: string;
    message: string;
    metrics?: ItemsGeneratorMetrics;
    parameters?: CreateItemsGeneratorDto;
    historyId?: string;
}

export type CancelGenerationMode = 'trigger' | 'in_process' | 'stale' | 'already_finished';

export interface CancelGenerationResponseDto {
    status: 'success';
    message: string;
    mode: CancelGenerationMode;
}
