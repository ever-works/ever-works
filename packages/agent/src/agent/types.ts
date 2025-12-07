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

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    source_url: string;
    category: string | string[] | Category | Category[];
    slug?: string;
    tags: string[] | Tag[];
    brand?: string | Brand;
    brand_logo_url?: string | null;
    images?: string[];
}
