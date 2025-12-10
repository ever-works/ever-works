export interface Identifiable {
    id: string;
    name: string;
}

export interface Category extends Identifiable {
    description?: string;
    icon_url?: string;
}

export interface Tag extends Identifiable {}

export interface Brand extends Identifiable {
    logo_url?: string;
    website?: string;
}

export interface Badge {
    value: string;
    evaluated_at?: string;
    details?: string | null;
    type?: string;
}

export type ItemBadges = Record<string, Badge>;

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    order?: number;
    source_url: string;
    category: string | string[] | Category | Category[];
    slug?: string;
    tags: string[] | Tag[];
    badges?: ItemBadges;
    brand?: string | Brand;
    brand_logo_url?: string | null;
    images?: string[];
}
