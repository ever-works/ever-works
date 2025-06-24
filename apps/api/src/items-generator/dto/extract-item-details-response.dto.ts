import { ItemData } from './item-data.dto';

export interface ExtractItemDetailsResponseDto {
    status: 'success' | 'error';
    source_url: string;
    item?: ItemData;
    message: string;
    error_details?: string;
}
