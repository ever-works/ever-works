import { z } from 'zod';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

// Security: these schemas validate LLM structured output. AI-generated URL
// fields (`source_url`, `brand_logo_url`, `images[]`) are persisted and later
// rendered as href/src and fetched server-side, so a plain `z.string()` would
// let an adversarial / prompt-injected model emit `javascript:`, `data:`,
// `file://`, or private/metadata-host URLs. `isSafeWebhookUrl` enforces a
// parseable URL, restricts the scheme to http(s), and blocks SSRF
// private/loopback/link-local + cloud-metadata hosts — the same guard the
// sibling Submit/Extract item DTOs apply to these exact fields. Applied to the
// inner string (before `.nullable()`) so null stays allowed; invalid items are
// already silently skipped by the per-item `.parse()` in the generation steps.
const safeHttpUrl = z.string().refine((value) => isSafeWebhookUrl(value), {
	message: 'URL must be a valid http(s) URL pointing to a public host'
});

/**
 * Base schema for item data
 */
const baseSchema = z.object({
	name: z.string().describe('The primary, canonical name of the item (tool, resource, library etc.)'),
	description: z
		.string()
		.describe(
			"A concise, informative summary of the item and its relevance to the main topic. If a good summary isn't directly available, generate one from the page content."
		)
});

/**
 * Schema for item data without categories/tags
 */
export const itemDataSchema = baseSchema.extend({
	// Security: http(s)-only, SSRF-guarded URL (see `safeHttpUrl` above).
	source_url: safeHttpUrl
		.nullable()
		.describe(
			'The most direct, stable, and canonical URL for the item itself. Must be a valid and highly relevant URL.'
		),
	featured: z.boolean().nullable().default(false),
	brand: z.string().nullable().describe('Optional brand/manufacturer associated with the item (one per item).'),
	// Security: http(s)-only, SSRF-guarded URL (see `safeHttpUrl` above).
	brand_logo_url: safeHttpUrl
		.nullable()
		.describe('Logo URL for the brand if available and canonical. Must be a valid URL.'),
	images: z
		// Security: each image URL is http(s)-only and SSRF-guarded (see `safeHttpUrl` above).
		.array(safeHttpUrl)
		.nullable()
		.default([])
		.describe(
			'Image URLs or screenshots that visually represent the item. Provide multiple when available. Each must be a valid URL.'
		)
});

/**
 * Schema for item data with categories and tags
 */
export const itemDataWithCategoriesAndTagsSchema = itemDataSchema.extend({
	slug: z.string().describe('URL-friendly slug, auto-generated from item.name if not provided.'),
	category: z
		.string()
		.describe(
			"One or more relevant high-level category names (e.g., 'Monitoring', 'CI/CD', 'Data Visualization')."
		),
	tags: z
		.array(z.string())
		.describe(
			"Specific keywords, technologies, or features associated with the item (e.g., 'real-time', 'open-source', 'golang')."
		),
	collection: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional curated collection this item belongs to (e.g., 'editors-picks', 'best-for-beginners'). At most one collection per item."
		)
});

/**
 * Schema for extracted items array
 */
export const extractedItemsSchema = z.object({
	items: z.array(itemDataSchema)
});

/**
 * Schema for extracted items with tags
 */
export const extractedItemsSchemaWithTags = z.object({
	items: z.array(itemDataWithCategoriesAndTagsSchema)
});

/**
 * Schema for prompt understanding assessment
 */
export const promptUnderstandingAssessmentSchema = z.object({
	can_proceed: z
		.boolean()
		.describe(
			'True if the AI has sufficient context and clarity from the prompt to generate a meaningful list of items. False otherwise.'
		),
	reason_if_cannot_proceed: z
		.string()
		.nullable()
		.describe(
			'If can_proceed is false, a brief explanation of why the prompt is too vague or lacks clarity for item generation. Null if can_proceed is true.'
		),
	suggested_clarifications: z
		.array(z.string())
		.nullable()
		.describe(
			'Optional: If can_proceed is false, specific questions or suggestions for the user to clarify the prompt.'
		)
});

/**
 * Schema for badge data
 */
const badgeSchema = z.object({
	value: z.string(),
	evaluated_at: z.string().nullable(),
	details: z.string().nullable()
});

/**
 * Schema for item badges
 */
export const itemBadgesSchema = z.record(badgeSchema.nullable());

/**
 * Schema for item data with badges
 */
export const itemDataWithBadgesSchema = baseSchema.extend({
	// Security: http(s)-only, SSRF-guarded URL (see `safeHttpUrl` above).
	source_url: safeHttpUrl
		.nullable()
		.describe(
			'The most direct, stable, and canonical URL for the item itself (e.g., project homepage, official documentation, GitHub repository etc.). Must be a valid and highly relevant URL.'
		),
	featured: z
		.boolean()
		.nullable()
		.default(false)
		.describe(
			"Determine if the item warrants a 'featured' status based on prominence, recommendations, or significance. Default to false."
		),
	badges: itemBadgesSchema.nullable(),
	brand: z.string().nullable().describe('Optional brand/manufacturer associated with the item (one per item).'),
	// Security: http(s)-only, SSRF-guarded URL (see `safeHttpUrl` above).
	brand_logo_url: safeHttpUrl
		.nullable()
		.describe('Logo URL for the brand if available and canonical. Must be a valid URL.'),
	images: z
		// Security: each image URL is http(s)-only and SSRF-guarded (see `safeHttpUrl` above).
		.array(safeHttpUrl)
		.nullable()
		.default([])
		.describe(
			'Image URLs or screenshots that visually represent the item. Provide multiple when available. Each must be a valid URL.'
		)
});
