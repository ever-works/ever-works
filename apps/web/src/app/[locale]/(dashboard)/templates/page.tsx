import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { templatesAPI } from '@/lib/api/templates';
import { gitProvidersAPI } from '@/lib/api';
import { TemplatesCatalog } from '@/components/templates/TemplatesCatalog';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('templates') };
}

export default async function TemplatesPage() {
    const [templatesData, gitUserResult, organizationsResult] = await Promise.all([
        templatesAPI.list('website').catch(() => ({
            status: 'success' as const,
            kind: 'website' as const,
            defaultTemplateId: null,
            templates: [],
        })),
        gitProvidersAPI.getUser('github').catch(() => ({
            success: false,
            user: null,
        })),
        gitProvidersAPI.getOrganizations('github').catch(() => ({
            success: false,
            organizations: [],
        })),
    ]);

    const forkTargets = [
        ...(gitUserResult.success && gitUserResult.user
            ? [
                  {
                      login: gitUserResult.user.login,
                      label: gitUserResult.user.name || gitUserResult.user.login,
                      kind: 'personal' as const,
                  },
              ]
            : []),
        ...((organizationsResult.success ? organizationsResult.organizations : []).map((org) => ({
            login: org.login,
            label: org.name || org.login,
            kind: 'organization' as const,
        })) || []),
    ];

    return (
        <div className="w-full overflow-auto">
            <TemplatesCatalog
                kind="website"
                templates={templatesData.templates}
                defaultTemplateId={templatesData.defaultTemplateId}
                forkTargets={forkTargets}
            />
        </div>
    );
}
