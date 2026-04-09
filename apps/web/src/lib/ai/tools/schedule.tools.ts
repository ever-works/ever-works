import { z } from 'zod';
import { tool } from 'ai';
import {
    updateDirectorySchedule,
    runDirectorySchedule,
    cancelDirectorySchedule,
} from '@/app/actions/dashboard/directory-schedule';
import { DirectoryScheduleCadence, DirectoryScheduleBillingMode } from '@/lib/api/enums';

export const setSchedule = tool({
    description: 'Enable or update a scheduled generation for a directory.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
        enable: z.boolean().describe('Enable or disable schedule'),
        cadence: z
            .enum(['hourly', 'daily', 'weekly', 'monthly'])
            .optional()
            .describe('How often to run (required when enabling)'),
    }),
    execute: async ({ directoryId, enable, cadence }) => {
        const cadenceMap: Record<string, DirectoryScheduleCadence> = {
            hourly: DirectoryScheduleCadence.HOURLY,
            every_3_hours: DirectoryScheduleCadence.EVERY_3_HOURS,
            every_8_hours: DirectoryScheduleCadence.EVERY_8_HOURS,
            every_12_hours: DirectoryScheduleCadence.EVERY_12_HOURS,
            daily: DirectoryScheduleCadence.DAILY,
            weekly: DirectoryScheduleCadence.WEEKLY,
            monthly: DirectoryScheduleCadence.MONTHLY,
        };
        const result = await updateDirectorySchedule(directoryId, {
            enable,
            cadence: cadenceMap[cadence ?? 'weekly'],
            billingMode: DirectoryScheduleBillingMode.USAGE,
            maxFailureBeforePause: 3,
        });
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const runScheduleNow = tool({
    description: 'Manually trigger a scheduled generation run for a directory.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        const result = await runDirectorySchedule(directoryId);
        return { success: result.success, message: result.message, error: result.error };
    },
});

export const cancelSchedule = tool({
    description: 'Cancel an active scheduled generation.',
    inputSchema: z.object({
        directoryId: z.string().describe('Directory ID'),
    }),
    execute: async ({ directoryId }) => {
        const result = await cancelDirectorySchedule(directoryId);
        return { success: result.success, message: result.message, error: result.error };
    },
});
