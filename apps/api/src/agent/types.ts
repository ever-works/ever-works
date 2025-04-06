export interface Identifable {
    id: string;
    name: string;
}

export interface Category extends Identifable {
    description?: string;
    icon_url?: string;
}

export interface Tag extends Identifable { }

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    source_url: string;
    category: string | string[] | Category | Category[];
    slug?: string;
    tags: string[] | Tag[];
}
