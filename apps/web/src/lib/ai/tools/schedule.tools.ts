import { z } from 'zod';
import { tool } from 'ai';
import {
    updateWorkSchedule,
    runWorkSchedule,
    cancelWorkSchedule,
} from '@/app/actions/dashboard/work-schedule';
import { WorkScheduleCadence, WorkScheduleBillingMode } from '@/lib/api/enums';
import type { UserConfirmationCheck } from './generated/confirmation';
import { CONFIRMED_FIELD_DESCRIPTION, requireUserConfirmation } from './confirm-gate';

type ChatCadence = 'hourly' | 'daily' | 'weekly' | 'monthly';

/**
 * Works-security (2026-10-18): enabling a schedule (or changing its cadence)
 * starts recurring paid generation runs nobody launches by hand, and
 * `runScheduleNow` starts one immediately — both are the user's call,
 * confirmed in their own message. Turning a schedule OFF needs no card.
 */
export function createSetScheduleTool(userConfirmed?: UserConfirmationCheck) {
    return tool({
        description: [
            'Enable or update a scheduled generation for a Work.',
            'Enabling or changing a schedule requires user confirmation (call once without `confirmed`, then again with `confirmed: true` after the user agrees); disabling does not.',
        ].join(' '),
        inputSchema: z.object({
            workId: z.string().describe('Work ID'),
            enable: z.boolean().describe('Enable or disable schedule'),
            cadence: z
                .enum(['hourly', 'daily', 'weekly', 'monthly'])
                .optional()
                .describe('How often to run (required when enabling)'),
            confirmed: z.boolean().optional().describe(CONFIRMED_FIELD_DESCRIPTION),
        }),
        execute: async ({ workId, enable, cadence, confirmed }) => {
            if (enable) {
                const args: Record<string, unknown> = { workId, enable };
                if (cadence !== undefined) args.cadence = cadence;
                const card = requireUserConfirmation({
                    toolName: 'setSchedule',
                    action: 'Enable or change a scheduled generation for a Work',
                    target: workId,
                    args,
                    confirmed,
                    userConfirmed,
                    kind: 'privileged',
                });
                if (card) return card;
            }
            return applySchedule(workId, enable, cadence);
        },
    });
}

/** Legacy flag-only instance (no user-turn check) — kept for existing imports. */
export const setSchedule = createSetScheduleTool();

async function applySchedule(workId: string, enable: boolean, cadence: ChatCadence | undefined) {
    const cadenceMap: Record<string, WorkScheduleCadence> = {
        hourly: WorkScheduleCadence.HOURLY,
        every_3_hours: WorkScheduleCadence.EVERY_3_HOURS,
        every_8_hours: WorkScheduleCadence.EVERY_8_HOURS,
        every_12_hours: WorkScheduleCadence.EVERY_12_HOURS,
        daily: WorkScheduleCadence.DAILY,
        weekly: WorkScheduleCadence.WEEKLY,
        monthly: WorkScheduleCadence.MONTHLY,
    };
    const result = await updateWorkSchedule(workId, {
        enable,
        cadence: cadenceMap[cadence ?? 'weekly'],
        // 🛑 SUBSCRIPTION, matching the entity default
        // (work-schedule.entity.ts:48). This used to hardcode USAGE, so
        // EVERY schedule the assistant created was silently pay-per-use —
        // a billing mode the user never chose and is never shown.
        //
        // That is not cosmetic. `billingMode === USAGE` currently skips two
        // entitlement gates: SubscriptionService.requiresUsageBilling
        // returns false for it (so a cadence the plan does not allow is
        // permitted), and WorkScheduleService.validateRunEntitlement returns
        // true immediately (so the plan's active-schedule cap is not
        // applied). Both are justified in-code by "assuming they can pay" —
        // but BillingProvider.recordUsageCharge is a no-op on every
        // provider, so nobody ever pays. Asking the assistant to set up a
        // schedule therefore granted unmetered capacity.
        //
        // This restores the default only. The bypass itself is still open
        // and is tracked separately; flipping it would pause existing
        // usage-mode schedules, which needs an owner decision.
        billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
        maxFailureBeforePause: 3,
    });
    return { success: result.success, message: result.message, error: result.error };
}

export function createRunScheduleNowTool(userConfirmed?: UserConfirmationCheck) {
    return tool({
        description: [
            'Manually trigger a scheduled generation run for a Work.',
            'Starts a paid run — requires user confirmation (call once without `confirmed`, then again with `confirmed: true` after the user agrees).',
        ].join(' '),
        inputSchema: z.object({
            workId: z.string().describe('Work ID'),
            confirmed: z.boolean().optional().describe(CONFIRMED_FIELD_DESCRIPTION),
        }),
        execute: async ({ workId, confirmed }) => {
            const card = requireUserConfirmation({
                toolName: 'runScheduleNow',
                action: 'Run a scheduled generation for a Work now',
                target: workId,
                args: { workId },
                confirmed,
                userConfirmed,
            });
            if (card) return card;
            const result = await runWorkSchedule(workId);
            return { success: result.success, message: result.message, error: result.error };
        },
    });
}

/** Legacy flag-only instance (no user-turn check) — kept for existing imports. */
export const runScheduleNow = createRunScheduleNowTool();

export const cancelSchedule = tool({
    description: 'Cancel an active scheduled generation.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const result = await cancelWorkSchedule(workId);
        return { success: result.success, message: result.message, error: result.error };
    },
});
