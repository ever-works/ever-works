import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { missionsAPI, type Mission } from '@/lib/api/missions';
import {
    cloneMissionAction,
    completeMissionAction,
    createMissionAction,
    deleteMissionAction,
    listMissionsAction,
    pauseMissionAction,
    resumeMissionAction,
    runMissionNowAction,
    updateMissionAction,
} from '@/app/actions/dashboard/missions';

/**
 * Phase 9 PR Z1 — in-app AI Chat tools for Missions (spec §3.8).
 *
 * Each `tool()` is a thin wrapper over the existing server actions /
 * API client (same path the dashboard pages already use). Auth +
 * ownership checks live in those layers — the tools inherit them
 * automatically because `'use server'` actions run with the user's
 * session context. We DO NOT bypass `missionsAPI` to call the agent
 * directly; the wire contract stays the same as button-driven flows.
 *
 * Returned shapes are intentionally trimmed — the chat model doesn't
 * need every entity field, just enough to confirm what it did + give
 * the user a navigable url. Full details land via `getMissionDetails`
 * or a follow-up `navigate` call.
 */

// Shape returned to the model for read-style tools. Hoisted so both
// the list and get tools share a single mapping.
function summarizeMission(m: Mission) {
    return {
        id: m.id,
        title: m.title,
        description: m.description,
        type: m.type,
        status: m.status,
        schedule: m.schedule,
        autoBuildWorks: m.autoBuildWorks,
        outstandingIdeasCap: m.outstandingIdeasCap,
        missionTemplateRepo: m.missionTemplateRepo,
        sourceMissionId: m.sourceMissionId,
        url: ROUTES.DASHBOARD_MISSION(m.id),
    };
}

// ────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────

export const listMissions = tool({
    description:
        'List the user\'s Missions. Use to find a Mission by title before invoking other Mission tools.',
    inputSchema: z.object({}),
    execute: async () => {
        const missions = await listMissionsAction();
        return {
            missions: missions.map(summarizeMission),
            total: missions.length,
        };
    },
});

export const getMissionDetails = tool({
    description: 'Get detailed info about a specific Mission.',
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        const mission = await missionsAPI.get(missionId);
        if (!mission) return { error: 'Mission not found' };
        return summarizeMission(mission);
    },
});

export const getMissionBudget = tool({
    description:
        'Get current-period spend + global cap status for a Mission. Use when the user asks about cost or budget.',
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        try {
            const budget = await missionsAPI.getBudget(missionId);
            return budget;
        } catch (err) {
            return { error: err instanceof Error ? err.message : 'Failed to load budget' };
        }
    },
});

// ────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────

export const createMission = tool({
    description: [
        'Create a new Mission. Default `type` is "one-shot" — flip to "scheduled" only when the user explicitly asks for recurring runs.',
        'When `type="scheduled"`, `schedule` MUST be a 5-field cron string (e.g. "0 9 * * *").',
        '`autoBuildWorks=true` makes the Mission auto-queue every spawned Idea for build — only do this if the user asked for it.',
    ].join(' '),
    inputSchema: z.object({
        description: z
            .string()
            .min(10)
            .describe('What the Mission should do — used as the AI Goal context'),
        title: z
            .string()
            .optional()
            .describe('Display title. Omit to let the server auto-title from the description.'),
        type: z.enum(['one-shot', 'scheduled']).optional().describe('Default "one-shot".'),
        schedule: z
            .string()
            .nullable()
            .optional()
            .describe('5-field cron expression. Required when type="scheduled".'),
        autoBuildWorks: z
            .boolean()
            .optional()
            .describe('When true, spawned Ideas are auto-queued for build.'),
        outstandingIdeasCap: z
            .number()
            .int()
            .min(-1)
            .nullable()
            .optional()
            .describe('Cap on un-built Ideas. -1 = unlimited; null = inherit user default.'),
    }),
    execute: async (input) => {
        const mission = await createMissionAction({
            description: input.description,
            type: input.type ?? 'one-shot',
            ...(input.title !== undefined && { title: input.title }),
            ...(input.schedule !== undefined && { schedule: input.schedule }),
            ...(input.autoBuildWorks !== undefined && { autoBuildWorks: input.autoBuildWorks }),
            ...(input.outstandingIdeasCap !== undefined && {
                outstandingIdeasCap: input.outstandingIdeasCap,
            }),
        });
        return { created: true, mission: summarizeMission(mission) };
    },
});

// ────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────

export const updateMission = tool({
    description: [
        'Update an existing Mission. Only provide fields the user wants to change.',
        'Tri-state semantics: omit a field to leave it unchanged; pass `null` to reset to default; pass a value to override.',
    ].join(' '),
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
        title: z.string().optional(),
        description: z.string().optional(),
        type: z.enum(['one-shot', 'scheduled']).optional(),
        schedule: z.string().nullable().optional(),
        autoBuildWorks: z.boolean().optional(),
        outstandingIdeasCap: z.number().int().min(-1).nullable().optional(),
    }),
    execute: async ({ missionId, ...patch }) => {
        const mission = await updateMissionAction(missionId, patch);
        return { updated: true, mission: summarizeMission(mission) };
    },
});

// ────────────────────────────────────────────────────────────────
// Lifecycle — pause / resume / complete / delete / run-now / clone
// ────────────────────────────────────────────────────────────────

export const pauseMission = tool({
    description:
        'Pause an active Mission. The cron tick worker will skip it until resumed. Only valid when status="active".',
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        const mission = await pauseMissionAction(missionId);
        return { paused: true, mission: summarizeMission(mission) };
    },
});

export const resumeMission = tool({
    description:
        'Resume a paused Mission. Tick worker picks it back up on the next cron match. Only valid when status="paused".',
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        const mission = await resumeMissionAction(missionId);
        return { resumed: true, mission: summarizeMission(mission) };
    },
});

export const completeMission = tool({
    description: [
        'Mark a Mission as completed (terminal state). Use when the user confirms the Mission has achieved its goal.',
        'Existing Ideas + Works remain; only the Mission itself stops spawning. Not reversible — surface a confirmation in chat before calling.',
    ].join(' '),
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        const mission = await completeMissionAction(missionId);
        return { completed: true, mission: summarizeMission(mission) };
    },
});

export const deleteMission = tool({
    description: [
        'Delete a Mission. DESTRUCTIVE — surface a confirmation in chat before calling.',
        'Removes the Mission row and detaches its Ideas (the Ideas themselves remain in the catalog).',
    ].join(' '),
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        await deleteMissionAction(missionId);
        return { deleted: true, missionId };
    },
});

export const runMissionNow = tool({
    description: [
        'Trigger a Mission tick immediately, bypassing the cron schedule.',
        'For one-shot Missions this is the primary way to spawn Ideas. For scheduled Missions it does an out-of-band run while still honoring the outstanding-Ideas cap.',
    ].join(' '),
    inputSchema: z.object({
        missionId: z.string().describe('Mission ID'),
    }),
    execute: async ({ missionId }) => {
        const result = await runMissionNowAction(missionId);
        return result;
    },
});

export const cloneMission = tool({
    description: [
        'Full-Fork clone a Mission: copies the Mission row + every Idea (including ACCEPTED/DONE), zeroes their statuses for the new owner.',
        'Use when the user wants to "duplicate" or "fork" a Mission.',
    ].join(' '),
    inputSchema: z.object({
        missionId: z.string().describe('Source Mission ID to clone from'),
        title: z
            .string()
            .optional()
            .describe('Title for the new Mission. Omit to reuse "<original> (copy)".'),
    }),
    execute: async ({ missionId, title }) => {
        const result = await cloneMissionAction(missionId, title);
        return {
            cloned: true,
            mission: summarizeMission(result.mission),
            ideasCloned: result.ideasCloned,
            ideasSkipped: result.ideasSkipped,
        };
    },
});
