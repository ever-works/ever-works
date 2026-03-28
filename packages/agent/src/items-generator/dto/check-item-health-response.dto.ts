import type { ItemData, ItemHealth } from '@ever-works/contracts';

export interface CheckItemHealthResponseDto {
    status: 'success' | 'error';
    item_slug: string;
    item_name: string;
    message: string;
    item?: ItemData;
    health?: ItemHealth;
}
