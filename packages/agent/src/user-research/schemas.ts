import { z } from 'zod';
import { isSafeWebhookUrl } from '../utils/ssrf-guard';

// Security (EW-715 #3): `sources[].url` is synthesized by the LLM from
// attacker-controlled web content, persisted to `user.inferredInterests`, and
// later re-fetched / re-injected into prompts. A bare `z.string().url()`
// happily accepts `http://169.254.169.254/...`, `http://localhost/...`, or any
// private-IP / cloud-metadata target, turning the persisted profile into a
// stored SSRF payload. Tighten the field to require `https:` AND reject SSRF
// targets via the shared lexical guard `isSafeWebhookUrl` (loopback / link-local
// / RFC1918 / cloud-metadata hostnames). The guard also rejects `http:`, but we
// additionally pin to `https:` here because every legitimate research source is
// a public HTTPS page. This refine runs on BOTH live boundaries:
//   - the `finalize` tool input (`finalize.tool.ts` → inputSchema), and
//   - the persistence re-parse in `user-research.service.ts`
//     (`inferredProfileSchema.parse(finalProfile)` before write).
const isSafeHttpsSourceUrl = (raw: string): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    // The shared lexical guard only recognises loopback by *literal IP*
    // (127.0.0.0/8, ::1). The bare hostname `localhost` (and its IPv6 aliases)
    // is not an IP literal, so `isSafeWebhookUrl('https://localhost/...')`
    // returns true. A legitimate research source is never a loopback host, so
    // reject those names here before deferring. (Kept local rather than widening
    // the shared guard, which other callers — e.g. the agent-memory localhost
    // default — intentionally allow.)
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback' || host.endsWith('.localhost')) {
        return false;
    }
    return isSafeWebhookUrl(raw);
};

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
                url: z
                    .string()
                    .url()
                    .refine(isSafeHttpsSourceUrl, {
                        message:
                            'Source url must be a public https URL (no http, private IPs, loopback, link-local, or cloud-metadata targets)',
                    }),
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
