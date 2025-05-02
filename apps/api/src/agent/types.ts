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
  slug?: string;
  category: string | string[] | Category | Category[];
  tags: string[] | Tag[];
}

export type InputItem = Partial<ItemData>;
