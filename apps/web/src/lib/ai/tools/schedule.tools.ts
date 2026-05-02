import { z } from 'zod';
import { tool } from 'ai';
import {
    updateWorkSchedule,
    runWorkSchedule,
    cancelWorkSchedule,
} from '@/app/actions/dashboard/work-schedule';
import { WorkScheduleCadence, WorkScheduleBillingMode } from '@/lib/api/enums';

export const setSchedule = tool({
    description: 'Enable or update a scheduled generation for a Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        enable: z.boolean().describe('Enable or disable schedule'),
        cadence: z
            .enum(['hourly', 'daily', 'weekly', 'monthly'])
            .optional()
            .describe('How often to run (required when enabling)'),
    }),
    execute: async ({ workId, enable, cadence }) => {
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
            billingMode: WorkScheduleBillingMode.USAGE,
            maxFailureBeforePause: 3,
        });
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const runScheduleNow = tool({
    description: 'Manually trigger a scheduled generation run for a Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const result = await runWorkSchedule(workId);
        return { success: result.success, message: result.message, error: result.error };
    },
});

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
