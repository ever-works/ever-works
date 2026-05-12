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
    reasoning: z.string().max(280),
});

export type WorkProposalDraft = z.infer<typeof workProposalSchema>;

export const workProposalsBatchSchema = z.object({
    proposals: z.array(workProposalSchema).min(1).max(5),
});

export type WorkProposalsBatch = z.infer<typeof workProposalsBatchSchema>;
