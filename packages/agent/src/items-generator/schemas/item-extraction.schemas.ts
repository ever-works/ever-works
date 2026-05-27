/**
 * Zod schemas for the LLM item-extraction pipeline.
 *
 * **The `.describe()` calls are load-bearing**, not human-only docs:
 * LangChain's `withStructuredOutput` passes them through to the model
 * as the field-by-field instructions for what to extract. Edits to a
 * description change the model's behaviour — treat them like prompts.
 *
 * Schema hierarchy (extension chain):
 *  - `baseSchema` — `name` + `description`. The minimal shape every
 *    extracted item must have.
 *  - `itemDataSchema` extends base with `source_url`, `featured`,
 *    `brand`, `brand_logo_url`, `images`. The shape the extraction
 *    step emits before classification.
 *  - `itemDataWithCategoriesAndTagsSchema` extends `itemDataSchema`
 *    with `slug`, `category`, `tags`. The shape after the
 *    categorisation step has assigned taxonomy.
 *  - `itemDataWithBadgesSchema` extends `baseSchema` (NOT
 *    `itemDataSchema`) and adds badges. Used by the badge-enrichment
 *    step; intentionally narrower than the full pipeline shape.
 *
 * Wrapper shapes:
 *  - `extractedItemsSchema` / `extractedItemsSchemaWithTags` —
 *    `{ items: [...] }` envelopes used as the structured-output
 *    targets for the bulk extract / classify calls.
 *  - `promptUnderstandingAssessmentSchema` — separate gate schema
 *    used BEFORE extraction; asks the model whether the user prompt
 *    is concrete enough to proceed at all.
 */
import { z } from 'zod';

const baseSchema = z.object({
    name: z
        .string()
        .describe('The primary, canonical name of the item (tool, resource, library etc.)'),
    description: z
        .string()
        .describe(
            "A concise, informative summary of the item and its relevance to the main topic. If a good summary isn't directly available, generate one from the page content.",
        ),
});

export const itemDataSchema = baseSchema.extend({
    source_url: z
        .string()
        .nullable()
        .describe(
            'The most direct, stable, and canonical URL for the item itself. Must be a valid and highly relevant URL.',
        ),
    featured: z.boolean().nullable().default(false),
    brand: z
        .string()
        .nullable()
        .describe('Optional brand/manufacturer associated with the item (one per item).'),
    brand_logo_url: z
        .string()
        .nullable()
        .describe('Logo URL for the brand if available and canonical. Must be a valid URL.'),
    images: z
        .array(z.string())
        .nullable()
        .default([])
        .describe(
            'Image URLs or screenshots that visually represent the item. Provide multiple when available. Each must be a valid URL.',
        ),
});

export const itemDataWithCategoriesAndTagsSchema = itemDataSchema.extend({
    slug: z.string().describe('URL-friendly slug, auto-generated from item.name if not provided.'),
    category: z
        .string()
        .describe(
            "One or more relevant high-level category names (e.g., 'Monitoring', 'CI/CD', 'Data Visualization').",
        ),
    tags: z
        .array(z.string())
        .describe(
            "Specific keywords, technologies, or features associated with the item (e.g., 'real-time', 'open-source', 'golang').",
        ),
});

export const extractedItemsSchema = z.object({
    items: z.array(itemDataSchema),
});

export const extractedItemsSchemaWithTags = z.object({
    items: z.array(itemDataWithCategoriesAndTagsSchema),
});

export const promptUnderstandingAssessmentSchema = z.object({
    can_proceed: z
        .boolean()
        .describe(
            'True if the AI has sufficient context and clarity from the prompt to generate a meaningful list of items. False otherwise.',
        ),
    reason_if_cannot_proceed: z
        .string()
        .nullable()
        .describe(
            'If can_proceed is false, a brief explanation of why the prompt is too vague or lacks clarity for item generation. Null if can_proceed is true.',
        ),
    suggested_clarifications: z
        .array(z.string())
        .nullable()
        .describe(
            'Optional: If can_proceed is false, specific questions or suggestions for the user to clarify the prompt.',
        ),
});

const badgeSchema = z.object({
    value: z.string(),
    evaluated_at: z.string().nullable(),
    details: z.string().nullable(),
});

export const itemBadgesSchema = z.record(badgeSchema.nullable());

export const itemDataWithBadgesSchema = baseSchema.extend({
    source_url: z
        .string()
        .nullable()
        .describe(
            'The most direct, stable, and canonical URL for the item itself (e.g., project homepage, official documentation, GitHub repository etc.). Must be a valid and highly relevant URL.',
        ),
    featured: z
        .boolean()
        .nullable()
        .default(false)
        .describe(
            "Determine if the item warrants a 'featured' status based on prominence, recommendations, or significance. Default to false.",
        ),
    badges: itemBadgesSchema.nullable(),
    brand: z
        .string()
        .nullable()
        .describe('Optional brand/manufacturer associated with the item (one per item).'),
    brand_logo_url: z
        .string()
        .nullable()
        .describe('Logo URL for the brand if available and canonical. Must be a valid URL.'),
    images: z
        .array(z.string())
        .nullable()
        .default([])
        .describe(
            'Image URLs or screenshots that visually represent the item. Provide multiple when available. Each must be a valid URL.',
        ),
});
