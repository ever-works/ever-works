import { Category } from './category.dto';
import { Tag } from './tag.dto';
import { ItemBadges } from './badge.dto';
import { Brand } from './brand.dto';

export interface Identifiable {
    id: string;
    name: string;
}

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    source_url: string;
    category: string | Category | Category[];
    slug?: string;
    tags: string[] | Tag[];
    markdown?: string;
    badges?: ItemBadges;
    brand?: string | Brand;
    brand_logo_url?: string | null;
    images?: string[];
}
