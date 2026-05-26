import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI, type WebsiteTemplateOption } from '@/lib/api';
import { pluginsAPI } from '@/lib/api/plugins';
import type { WorkPlugin } from '@/lib/api/plugins';
import { GeneratorForm } from '@/components/works/detail/generator/GeneratorForm';
import { GenerationProgress } from '@/components/works/detail/generator/GenerationProgress';
import { GenerateStatusType } from '@/lib/api/enums';
import { canGenerate } from '@/lib/permissions';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('generator') };
}

type Params = {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ starting?: string }>;
};

export default async function WorkGeneratorPage({ params, searchParams }: Params) {
    const { id } = await params;
    const { starting } = await searchParams;

    let work;

    try {
        const workRes = await workAPI.get(id);
        work = workRes.work;
    } catch {
        notFound();
    }

    // Server-side permission check: only editors+ can access generator
    if (!canGenerate(work.userRole)) {
        notFound();
    }

    // If currently generating, show progress
    if (work.generateStatus?.status === GenerateStatusType.GENERATING) {
        return <GenerationProgress work={work} />;
    }

    // `config` comes from the cached `works.yml` payload on the
    // Work entity (populated by `DataGeneratorService.refreshDataCache`),
    // so the Generator tab opens without a git clone. The remaining
    // two fetches are DB-only / cheap plugin metadata.
    const [websiteTemplatesRes, pluginsRes] = await Promise.all([
        workAPI
            .getWebsiteTemplates()
            .catch((): { templates: WebsiteTemplateOption[] } => ({ templates: [] })),
        pluginsAPI.listForWork(id).catch((): { plugins: WorkPlugin[] } => ({ plugins: [] })),
    ]);

    return (
        <GeneratorForm
            workId={id}
            work={work}
            config={work.configCache ?? undefined}
            websiteTemplates={websiteTemplatesRes.templates}
            workPlugins={pluginsRes.plugins}
            startInProgressView={starting === '1'}
        />
    );
}
