import { CreateItemsGeneratorDto } from './create-items-generator.dto';

export interface ItemsGeneratorMetrics {
    urls_scanned: number;
    pages_processed: number;
    items_extracted_current_run: number;
    new_items_added_to_store: number;
    total_items_in_store: number;
    // total_categories_in_store: number;
    // total_tags_in_store: number;
}

export interface ItemsGeneratorResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    metrics?: ItemsGeneratorMetrics;
    parameters?: CreateItemsGeneratorDto;
}
