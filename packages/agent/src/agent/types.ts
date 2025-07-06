export interface Identifiable {
  id: string;
  name: string;
}

export interface Category extends Identifiable {
  description?: string;
  icon_url?: string;
}

export interface Tag extends Identifiable {}

export interface ItemData {
  name: string;
  description: string;
  featured?: boolean;
  source_url: string;
  category: string | string[] | Category | Category[];
  slug?: string;
  tags: string[] | Tag[];
}
