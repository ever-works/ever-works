import { z } from 'zod';

export const inferredProfileSchema = z.object({
    industry: z.string().optional(),
    role: z.string().optional(),
    expertise: z.array(z.string()).max(10),
    topics: z.array(z.string()).max(20),
    businessType: z.string().optional(),
    confidence: z.enum(['low', 'medium', 'high']),
    sources: z
        .array(
            z.object({
                url: z.string().url(),
                title: z.string(),
            }),
        )
        .max(10),
});

export type InferredProfile = z.infer<typeof inferredProfileSchema>;

export const workProposalSchema = z.object({
    title: z.string().min(8).max(80),
    description: z.string().min(20).max(280),
    slugSuggestion: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    suggestedCategories: z
        .array(
            z.object({
                name: z.string(),
                slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            }),
        )
        .min(2)
        .max(8),
    suggestedFields: z
        .array(
            z.object({
                name: z.string(),
                type: z.enum(['string', 'url', 'image', 'number', 'enum', 'markdown']),
            }),
        )
        .max(10),
    recommendedPlugins: z
        .array(
            z.object({
                pluginId: z.string(),
                reason: z.string(),
            }),
        )
        .max(5),
    generatedPrompt: z.string().min(20).max(1000),
    reasoning: z.string().max(280),
});

export type WorkProposalDraft = z.infer<typeof workProposalSchema>;

export const workProposalsBatchSchema = z.object({
    proposals: z.array(workProposalSchema).min(1).max(5),
});

export type WorkProposalsBatch = z.infer<typeof workProposalsBatchSchema>;

/**
 * Permissive variant used as the structured-output schema for the LLM call.
 * Lower-quality / free-tier models routinely violate the strict bounds
 * (slug regex, exact enum, length min/max), which makes generateObject reject
 * the whole batch with `No object generated: response did not match schema.`
 *
 * Strategy: accept loose shapes here, then run every draft through
 * coerceWorkProposal() to clip, slugify and filter into the strict shape
 * before persisting. Anything still un-salvageable is dropped, and we only
 * fail if zero valid proposals remain.
 */
export const permissiveWorkProposalSchema = z
    .object({
        title: z.unknown().optional(),
        description: z.unknown().optional(),
        slugSuggestion: z.unknown().optional(),
        suggestedCategories: z.unknown().optional(),
        suggestedFields: z.unknown().optional(),
        recommendedPlugins: z.unknown().optional(),
        generatedPrompt: z.unknown().optional(),
        reasoning: z.unknown().optional(),
    })
    .passthrough();

export type PermissiveWorkProposalDraft = z.infer<typeof permissiveWorkProposalSchema>;

export const permissiveWorkProposalsBatchSchema = z.object({
    proposals: z.array(permissiveWorkProposalSchema).optional().default([]),
});

export type PermissiveWorkProposalsBatch = z.infer<typeof permissiveWorkProposalsBatchSchema>;
