'use server';

import { z } from 'zod';
import { directoryAPI } from '@/lib/api';
import { DirectoryScheduleBillingMode, DirectoryScheduleCadence } from '@/lib/api/enums';
import { getAuthFromCookie } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';

const updateScheduleSchema = z.object({
    enable: z.boolean(),
    cadence: z.nativeEnum(DirectoryScheduleCadence),
    billingMode: z.nativeEnum(DirectoryScheduleBillingMode),
    maxFailureBeforePause: z.number().int().min(1).max(10),
});

export async function updateDirectorySchedule(
    directoryId: string,
    payload: z.infer<typeof updateScheduleSchema>,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { success: false, error: 'Not authenticated' };
    }

    const validation = updateScheduleSchema.safeParse(payload);
    if (!validation.success) {
        return { success: false, error: validation.error.errors[0]?.message || 'Invalid data' };
    }

    try {
        await directoryAPI.updateSchedule(directoryId, validation.data);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY(directoryId));

        return {
            success: true,
            message: 'Schedule updated.',
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update schedule.',
        };
    }
}

export async function runDirectorySchedule(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { success: false, error: 'Not authenticated' };
    }

    try {
        await directoryAPI.runSchedule(directoryId);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY(directoryId));
        return { success: true, message: 'Scheduled run started.' };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to trigger run.',
        };
    }
}

export async function cancelDirectorySchedule(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { success: false, error: 'Not authenticated' };
    }

    try {
        await directoryAPI.cancelSchedule(directoryId);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY(directoryId));
        return { success: true, message: 'Schedule cancelled.' };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to cancel schedule.',
        };
    }
}
