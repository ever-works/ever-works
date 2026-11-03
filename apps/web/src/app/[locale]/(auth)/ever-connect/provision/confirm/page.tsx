import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
    everConnectProvisionAPI,
    ProvisionRequestError,
    type ProvisionSummary,
} from '@/lib/api/ever-connect-provision';
import { serverFetch } from '@/lib/api/server-api';
import { readProvisionCookie } from '@/lib/auth/ever-connect-provision-cookie';
import { ProvisionConfirmClient, type ProvisionTemplateOption } from './provision-confirm-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('everConnect.provision');
    return { title: t('confirmPageTitle'), robots: { index: false, follow: false } };
}

async function templateOptions(enabled: boolean): Promise<ProvisionTemplateOption[]> {
    if (!enabled) return [];
    try {
        const templates = await serverFetch<Array<{ slug?: unknown; name?: unknown }>>(
            '/org-templates',
            { publicRouteScope: 'personal' },
        );
        return (Array.isArray(templates) ? templates : []).flatMap((template) =>
            typeof template.slug === 'string'
                ? [
                      {
                          slug: template.slug,
                          name: typeof template.name === 'string' ? template.name : template.slug,
                      },
                  ]
                : [],
        );
    } catch {
        // The catalog answers an empty list when it cannot be read; so does this.
        return [];
    }
}

/**
 * The one confirmation of a company request from Ever. Behind the auth gate: the
 * API checks that the signed-in person's connected Ever ID is the one the request
 * names, and the page says so when it is not.
 */
export default async function EverConnectProvisionConfirmPage() {
    const cookie = await readProvisionCookie();
    if (!cookie) return <ProvisionConfirmClient failure="expired" />;

    let summary: ProvisionSummary;
    try {
        summary = await everConnectProvisionAPI.summary(cookie.provisionTxn);
    } catch (error) {
        const failure =
            error instanceof ProvisionRequestError
                ? error.code === 'intent_subject_mismatch'
                    ? 'mismatch'
                    : error.status === 404 || error.status === 410
                      ? 'expired'
                      : 'failed'
                : 'unreachable';
        return <ProvisionConfirmClient failure={failure} />;
    }

    return (
        <ProvisionConfirmClient
            summary={summary}
            templates={await templateOptions(summary.capabilities.provisionCompany)}
        />
    );
}
