'use server';

import { z } from 'zod';
import { directoryAPI } from '@/lib/api';
import { DirectoryScheduleBillingMode, DirectoryScheduleCadence } from '@/lib/api/enums';
import { getAuthFromCookie } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';

const providerOverridesSchema = z
    .object({
        pipeline: z.string().optional(),
        ai: z.string().optional(),
        search: z.string().optional(),
        screenshot: z.string().optional(),
        contentExtractor: z.string().optional(),
    })
    .nullish();

const updateScheduleSchema = z.object({
    enable: z.boolean(),
    cadence: z.nativeEnum(DirectoryScheduleCadence),
    billingMode: z.nativeEnum(DirectoryScheduleBillingMode),
    maxFailureBeforePause: z.number().int().min(1).max(10),
    alwaysCreatePullRequest: z.boolean().optional(),
    providerOverrides: providerOverridesSchema,
});

export async function updateDirectorySchedule(
    directoryId: string,
    payload: z.infer<typeof updateScheduleSchema>,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { success: false, error: 'Not authenticated' };
    }

    const t = await getTranslations('dashboard.directoryDetail.schedule.actions');

    const validation = updateScheduleSchema.safeParse(payload);
    if (!validation.success) {
        return { success: false, error: validation.error.errors[0]?.message || t('invalid') };
    }

    try {
        await directoryAPI.updateSchedule(directoryId, validation.data);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY(directoryId));

        return {
            success: true,
            message: t('updated'),
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}

export async function runDirectorySchedule(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { success: false, error: 'Not authenticated' };
    }

    const t = await getTranslations('dashboard.directoryDetail.schedule.actions');

    try {
        await directoryAPI.runSchedule(directoryId);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY(directoryId));
        return { success: true, message: t('runStarted') };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : t('runFailed'),
        };
    }
}

export async function cancelDirectorySchedule(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { success: false, error: 'Not authenticated' };
    }

    const t = await getTranslations('dashboard.directoryDetail.schedule.actions');

    try {
        await directoryAPI.cancelSchedule(directoryId);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY(directoryId));
        return { success: true, message: t('cancelled') };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : t('cancelFailed'),
        };
    }
}
