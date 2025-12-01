import { Category } from './category.dto';
import { Tag } from './tag.dto';
import { ItemBadges } from './badge.dto';

export interface Identifiable {
    id: string;
    name: string;
}

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    source_url: string;
    category: string | Category;
    slug?: string;
    tags: string[] | Tag[];
    markdown?: string;
    badges?: ItemBadges;
    entity_type?: string;
    entity_confidence?: number;
}
