export interface ItemData {
  name: string;
  description: string;
  featured?: boolean; // Default to false
  source_url: string; // Validated, direct URL to the item
  slug?: string; // Auto-generated from item.name
  category: string | string[]; // Names of categories, referencing Category.name or Category.id
  tags: string[]; // Names of tags, referencing Tag.name or Tag.id
}
