import type { ItemData } from '@ever-works/contracts';

export interface ExtractItemDetailsResponseDto {
    status: 'success' | 'error';
    source_url: string;
    item?: ItemData;
    message: string;
}
