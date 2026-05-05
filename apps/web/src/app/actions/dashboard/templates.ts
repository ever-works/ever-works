'use server';

import { templatesAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

function getResponseMessage(response: unknown): string | null {
    if (
        response &&
        typeof response === 'object' &&
        'message' in response &&
        typeof response.message === 'string' &&
        response.message.trim()
    ) {
        return response.message;
    }

    return null;
}

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
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.addFailed')
                    : null,
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
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.defaultFailed')
                    : null,
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

export async function forkTemplate(input: {
    kind: 'website' | 'work';
    templateId: string;
    targetOwner: string;
}) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.fork(input);

        revalidatePath(ROUTES.DASHBOARD_TEMPLATES);
        revalidatePath(ROUTES.DASHBOARD_WORKS_NEW);

        return {
            success: response.status === 'success',
            created: response.created ?? false,
            template: response.template ?? null,
            repository: response.repository ?? null,
            defaultTemplateId: response.defaultTemplateId ?? null,
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.forkFailed')
                    : null,
        };
    } catch (error) {
        console.error('Fork template error:', error);
        return {
            success: false,
            created: false,
            template: null,
            repository: null,
            defaultTemplateId: null,
            error: error instanceof Error ? error.message : t('messages.forkFailed'),
        };
    }
}
