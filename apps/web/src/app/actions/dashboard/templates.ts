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
    betaBranch?: string;
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

export async function updateCustomTemplate(
    templateId: string,
    input: {
        kind: 'website' | 'work';
        name?: string;
        description?: string;
        framework?: string;
        previewImageUrl?: string | null;
        branch?: string;
        betaBranch?: string | null;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.updateCustom(templateId, input);

        revalidatePath(ROUTES.DASHBOARD_TEMPLATES);

        return {
            success: response.status === 'success',
            template: response.template ?? null,
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.updateFailed')
                    : null,
        };
    } catch (error) {
        console.error('Update custom template error:', error);
        return {
            success: false,
            template: null,
            error: error instanceof Error ? error.message : t('messages.updateFailed'),
        };
    }
}

export async function archiveCustomTemplate(
    templateId: string,
    input: { kind: 'website' | 'work' },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.archiveCustom(templateId, input);

        revalidatePath(ROUTES.DASHBOARD_TEMPLATES);
        revalidatePath(ROUTES.DASHBOARD_WORKS_NEW);

        return {
            success: response.status === 'success',
            templateId: response.templateId ?? null,
            archived: response.archived ?? false,
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.archiveFailed')
                    : null,
        };
    } catch (error) {
        console.error('Archive custom template error:', error);
        return {
            success: false,
            templateId: null,
            archived: false,
            error: error instanceof Error ? error.message : t('messages.archiveFailed'),
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

export async function customizeTemplateFromBase(input: {
    baseTemplateId: string;
    name: string;
    prompt: string;
    providerId: string;
    aiProviderId?: string;
    targetOwner?: string;
    description?: string;
}) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.customizeFromBase(input);
        return {
            success: response.status === 'success',
            customizationId: response.customizationId ?? null,
            template: response.template ?? null,
            customization: response.customization ?? null,
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.customizeFailed')
                    : null,
        };
    } catch (error) {
        console.error('Customize template error:', error);
        return {
            success: false,
            customizationId: null,
            template: null,
            customization: null,
            error: error instanceof Error ? error.message : t('messages.customizeFailed'),
        };
    }
}

export async function listCustomizationProviders() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await templatesAPI.listCustomizationProviders();
        return {
            success: response.status === 'success',
            providers: response.providers ?? [],
            error: response.status === 'error' ? getResponseMessage(response) : null,
        };
    } catch (error) {
        console.error('List customization providers error:', error);
        return {
            success: false,
            providers: [],
            error: error instanceof Error ? error.message : 'unknown',
        };
    }
}

export async function listCustomizationAiProviders() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await templatesAPI.listCustomizationAiProviders();
        return {
            success: response.status === 'success',
            providers: response.providers ?? [],
            error: response.status === 'error' ? getResponseMessage(response) : null,
        };
    } catch (error) {
        console.error('List customization AI providers error:', error);
        return {
            success: false,
            providers: [],
            error: error instanceof Error ? error.message : 'unknown',
        };
    }
}

export async function getTemplateCustomization(customizationId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await templatesAPI.getCustomization(customizationId);
        return {
            success: response.status === 'success',
            customization: response.customization ?? null,
            error: response.status === 'error' ? getResponseMessage(response) : null,
        };
    } catch (error) {
        console.error('Get template customization error:', error);
        return {
            success: false,
            customization: null,
            error: error instanceof Error ? error.message : 'unknown',
        };
    }
}

export async function refreshTemplates(input: { kind: 'website' | 'work' }) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.templates');

    try {
        const response = await templatesAPI.refresh(input);

        revalidatePath(ROUTES.DASHBOARD_TEMPLATES);

        return {
            success: response.status === 'success',
            templates: response.templates ?? [],
            defaultTemplateId: response.defaultTemplateId ?? null,
            error:
                response.status === 'error'
                    ? getResponseMessage(response) || t('messages.refreshFailed')
                    : null,
        };
    } catch (error) {
        console.error('Refresh templates error:', error);
        return {
            success: false,
            templates: [],
            defaultTemplateId: null,
            error: error instanceof Error ? error.message : t('messages.refreshFailed'),
        };
    }
}
