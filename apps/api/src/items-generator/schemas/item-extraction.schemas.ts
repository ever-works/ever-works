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

// Zod schema for ItemData extraction
export const itemDataSchema = baseSchema.extend({
    source_url: z
        .string()
        .nullable()
        .describe(
            'The most direct, stable, and canonical URL for the item itself (e.g., project homepage, official documentation, GitHub repository etc.). Must be a valid and highly relevant URL.',
        ),
    featured: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "Determine if the item warrants a 'featured' status based on prominence, recommendations, or significance. Default to false.",
        ),
});

export const itemDataWithCategoriesAndTagsSchema = baseSchema.extend({
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

// Type for the extracted item, can be an array if multiple items are found on a page
export const extractedItemsSchema = z.object({
    items: z.array(itemDataSchema),
});

// Zod schema for AI's assessment of prompt understanding
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
