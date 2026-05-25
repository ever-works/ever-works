import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { templatesAPI, type TemplateKind } from '@/lib/api/templates';
import { gitProvidersAPI } from '@/lib/api';
import { TemplatesCatalog } from '@/components/templates/TemplatesCatalog';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('templates') };
}

/**
 * Phase 8 PR W — `/templates` reads an optional `?kind=` query
 * param so the kind-switch toggle (Mission / Work / Website) can
 * flip catalogs without bouncing the user to a different route.
 * Spec §10 calls for Mission Templates to be the default once
 * PR X seeds the catalog; for now the legacy `'website'` stays
 * the implicit default so existing users see the same page
 * they're used to.
 */
type SearchParams = Promise<{ kind?: string }>;

const VALID_KINDS: TemplateKind[] = ['website', 'work', 'mission'];

export default async function TemplatesPage({ searchParams }: { searchParams: SearchParams }) {
    const params = await searchParams;
    const raw = (params?.kind ?? '').trim().toLowerCase();
    const kind: TemplateKind = (VALID_KINDS as string[]).includes(raw)
        ? (raw as TemplateKind)
        : 'website';

    const [templatesData, gitUserResult, organizationsResult, providersResult, aiProvidersResult] =
        await Promise.all([
            templatesAPI.list(kind).catch(() => ({
                status: 'success' as const,
                kind,
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
            templatesAPI.listCustomizationProviders().catch(() => ({
                status: 'success' as const,
                providers: [],
            })),
            templatesAPI.listCustomizationAiProviders().catch(() => ({
                status: 'success' as const,
                providers: [],
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
                kind={kind}
                templates={templatesData.templates}
                defaultTemplateId={templatesData.defaultTemplateId}
                forkTargets={forkTargets}
                customizationProviders={providersResult.providers ?? []}
                customizationAiProviders={aiProvidersResult.providers ?? []}
            />
        </div>
    );
}
