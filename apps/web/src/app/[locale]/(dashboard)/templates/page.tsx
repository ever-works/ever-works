import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { templatesAPI } from '@/lib/api/templates';
import { TemplatesCatalog } from '@/components/templates/TemplatesCatalog';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('templates') };
}

export default async function TemplatesPage() {
    const templatesData = await templatesAPI.list('website').catch(() => ({
        status: 'success' as const,
        kind: 'website' as const,
        defaultTemplateId: null,
        templates: [],
    }));

    return (
        <div className="w-full overflow-auto">
            <TemplatesCatalog
                kind="website"
                templates={templatesData.templates}
                defaultTemplateId={templatesData.defaultTemplateId}
            />
        </div>
    );
}
