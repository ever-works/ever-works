'use server';

import { templatesAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

export async function addCustomTemplate(input: {
    kind: 'website' | 'work';
    repositoryUrl: string;
    name?: string;
    description?: string;
    framework?: string;
    previewImageUrl?: string;
    branch?: string;
}) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.addCustom(input);

        revalidatePath(ROUTES.DASHBOARD_TEMPLATES);

        return {
            success: response.status === 'success',
            template: response.template,
            error: response.status === 'error' ? t('messages.addFailed') : null,
        };
    } catch (error) {
        console.error('Add custom template error:', error);
        return {
            success: false,
            template: null,
            error: error instanceof Error ? error.message : t('messages.addFailed'),
        };
    }
}

export async function setDefaultTemplate(input: { kind: 'website' | 'work'; templateId: string }) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.setDefault(input);

        revalidatePath(ROUTES.DASHBOARD_TEMPLATES);
        revalidatePath(ROUTES.DASHBOARD_WORKS_NEW);

        return {
            success: response.status === 'success',
            defaultTemplateId: response.defaultTemplateId,
            error: response.status === 'error' ? t('messages.defaultFailed') : null,
        };
    } catch (error) {
        console.error('Set default template error:', error);
        return {
            success: false,
            defaultTemplateId: null,
            error: error instanceof Error ? error.message : t('messages.defaultFailed'),
        };
    }
}
