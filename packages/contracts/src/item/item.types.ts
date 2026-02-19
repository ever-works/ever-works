/**
 * Identifiable entity with id and name
 */
export interface Identifiable {
	readonly id: string;
	readonly name: string;
}

/**
 * Category for organizing items in a directory
 */
export interface Category {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly icon_url?: string;
	/** Lower numbers = higher priority (e.g., 1 = first, 2 = second, etc.) */
	readonly priority?: number;
}

/**
 * Tag for labeling items
 */
export interface Tag {
	readonly id: string;
	readonly name: string;
}

/**
 * Collection for curated item lists that span across categories
 */
export interface Collection {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly icon_url?: string;
	/** Lower numbers = higher priority (e.g., 1 = first, 2 = second, etc.) */
	readonly priority?: number;
}

/**
 * Brand information for items
 */
export interface Brand {
	readonly id: string;
	readonly name: string;
	readonly logo_url?: string;
	readonly website?: string;
}

/**
 * Badge representing an evaluated attribute of an item
 */
export interface Badge {
	readonly value: string;
	readonly evaluated_at?: string;
	readonly details?: string | null;
	/** Legacy field for backward compatibility */
	readonly type?: string;
}

/**
 * Collection of badges for an item, keyed by badge name
 */
export type ItemBadges = Record<string, Badge>;

/**
 * Result of badge evaluation for an item
 */
export interface BadgeEvaluationResult {
	readonly badges: ItemBadges;
	readonly evaluation_summary: string;
	readonly evaluated_at: string;
	readonly domain_type?: string;
}

/**
 * Core item data structure for directory entries
 */
export interface ItemData {
	readonly name: string;
	readonly description: string;
	readonly featured?: boolean;
	readonly order?: number;
	readonly source_url: string;
	readonly category: string | readonly string[];
	readonly slug?: string;
	readonly tags: readonly string[] | readonly Tag[];
	readonly collection?: string;
	readonly markdown?: string;
	readonly badges?: ItemBadges;
	readonly brand?: string | Brand;
	readonly brand_logo_url?: string | null;
	readonly images?: readonly string[];
}

/**
 * Mutable version of ItemData for use during processing
 */
export interface MutableItemData {
	name: string;
	description: string;
	featured?: boolean;
	order?: number;
	source_url: string;
	category: string | string[];
	slug?: string;
	tags: string[] | Tag[];
	collection?: string;
	markdown?: string;
	badges?: ItemBadges;
	brand?: string | Brand;
	brand_logo_url?: string | null;
	images?: string[];
}
