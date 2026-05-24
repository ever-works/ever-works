import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { workProposalsAPI, type WorkProposal } from '@/lib/api/work-proposals';
import {
    acceptProposalAction,
    buildIdeaAction,
    createIdeaAction,
    dismissProposalAction,
    getProposalsStatusAction,
    listProposalsAction,
    refreshProposalsAction,
} from '@/app/actions/dashboard/work-proposals';

/**
 * Phase 9 PR Z1 — in-app AI Chat tools for Ideas (spec §4.5).
 *
 * Same wrapping rule as missions.tools: each `tool()` delegates to
 * the existing server actions / API client so auth + ownership +
 * throttling are all inherited from the layers the dashboard pages
 * already exercise. No direct agent calls — the wire contract stays
 * single-sourced.
 */

// Summary the model gets back for read operations. Skips bulky
// suggestion arrays (the model rarely needs them; if it does it can
// call getIdeaDetails for the full surface).
function summarizeIdea(p: WorkProposal) {
    return {
        id: p.id,
        title: p.title,
        description: p.description,
        slugSuggestion: p.slugSuggestion,
        source: p.source,
        status: p.status,
        missionId: p.missionId ?? null,
        acceptedWorkId: p.acceptedWorkId ?? null,
        failureKind: p.failureKind ?? null,
        failureMessage: p.failureMessage ?? null,
        generatedAt: p.generatedAt,
        url: ROUTES.DASHBOARD_IDEAS,
    };
}

// ────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────

const IDEA_STATUSES = [
    'pending',
    'dismissed',
    'accepted',
    'queued',
    'building',
    'failed',
] as const;

export const listIdeas = tool({
    description: [
        'List the user\'s Ideas, filtered by status. Default = pending.',
        'When the user mentions a specific Mission, pass `missionId` to scope to just that Mission\'s Ideas.',
    ].join(' '),
    inputSchema: z.object({
        statuses: z
            .array(z.enum(IDEA_STATUSES))
            .optional()
            .describe('Statuses to include. Defaults to ["pending"].'),
        missionId: z
            .string()
            .optional()
            .describe('Scope to a single Mission. Omit for all Ideas.'),
    }),
    execute: async ({ statuses, missionId }) => {
        const ideas = await listProposalsAction(
            statuses && statuses.length > 0 ? statuses : ['pending'],
            missionId ? { missionId } : {},
        );
        return {
            ideas: ideas.map(summarizeIdea),
            total: ideas.length,
        };
    },
});

export const getIdeaDetails = tool({
    description: 'Get full info about a single Idea, including its suggested categories/fields/plugins.',
    inputSchema: z.object({
        ideaId: z.string().describe('Idea / WorkProposal ID'),
    }),
    execute: async ({ ideaId }) => {
        const idea = await workProposalsAPI.get(ideaId);
        if (!idea) return { error: 'Idea not found' };
        return {
            ...summarizeIdea(idea),
            suggestedCategories: idea.suggestedCategories,
            suggestedFields: idea.suggestedFields,
            recommendedPlugins: idea.recommendedPlugins,
            reasoning: idea.reasoning,
        };
    },
});

export const getIdeaBudget = tool({
    description:
        'Get current-period spend + global cap status for an Idea. Use when the user asks about an Idea\'s cost.',
    inputSchema: z.object({
        ideaId: z.string().describe('Idea ID'),
    }),
    execute: async ({ ideaId }) => {
        try {
            const budget = await workProposalsAPI.getBudget(ideaId);
            return budget;
        } catch (err) {
            return { error: err instanceof Error ? err.message : 'Failed to load budget' };
        }
    },
});

export const getIdeasRefreshStatus = tool({
    description:
        'Check whether the Ideas refresh button is available right now (returns researching flag + rate-limit state).',
    inputSchema: z.object({}),
    execute: async () => {
        return getProposalsStatusAction();
    },
});

// ────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────

export const createIdea = tool({
    description: [
        'Create a new user-manual Idea from a free-form description.',
        'Server auto-derives the title from the description when omitted (PR I title-fallback).',
    ].join(' '),
    inputSchema: z.object({
        description: z.string().min(10).describe('What the Idea is — used to seed the AI Goal.'),
        title: z.string().optional().describe('Optional display title.'),
    }),
    execute: async ({ description, title }) => {
        const idea = await createIdeaAction({
            description,
            ...(title !== undefined && { title }),
        });
        return { created: true, idea: summarizeIdea(idea) };
    },
});

export const refreshIdeas = tool({
    description: [
        'Trigger the AI Ideas-research job to generate fresh proposals from the user\'s context.',
        'Server enforces a rate-limit; the tool returns `status: "rate-limited"` rather than throwing when the cap is hit.',
    ].join(' '),
    inputSchema: z.object({}),
    execute: async () => {
        return refreshProposalsAction();
    },
});

// ────────────────────────────────────────────────────────────────
// Lifecycle — build / dismiss / accept
// ────────────────────────────────────────────────────────────────

export const buildIdea = tool({
    description: [
        'Queue an Idea for build. Transitions status PENDING/FAILED → QUEUED and spawns a WorkAgentGoal under the hood.',
        'Returns the new goal id so the user can navigate to the live-run view.',
    ].join(' '),
    inputSchema: z.object({
        ideaId: z.string().describe('Idea ID to queue for build'),
    }),
    execute: async ({ ideaId }) => {
        const result = await buildIdeaAction(ideaId);
        return {
            queued: true,
            idea: summarizeIdea(result.idea),
            goalId: result.goalId,
        };
    },
});

export const dismissIdea = tool({
    description: [
        'Dismiss an Idea so it stops showing in the pending list.',
        'Used when the user explicitly says they\'re not interested. NOT reversible from the UI — surface a confirmation in chat first.',
    ].join(' '),
    inputSchema: z.object({
        ideaId: z.string().describe('Idea ID to dismiss'),
    }),
    execute: async ({ ideaId }) => {
        await dismissProposalAction(ideaId);
        return { dismissed: true, ideaId };
    },
});

export const acceptIdea = tool({
    description: [
        'Link an Idea to a pre-existing Work (manual accept, NOT a build).',
        'Use when the user already has a Work that fulfills the Idea and just wants the back-reference.',
        'Use `buildIdea` instead when they want a brand-new Work generated.',
    ].join(' '),
    inputSchema: z.object({
        ideaId: z.string().describe('Idea ID to accept'),
        workId: z.string().describe('Existing Work ID to link the Idea to'),
    }),
    execute: async ({ ideaId, workId }) => {
        const result = await acceptProposalAction(ideaId, workId);
        return { ...result, ideaId, workId };
    },
});
