import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI } from '@/lib/api';
import { GeneratorForm } from '@/components/directories/detail/generator/GeneratorForm';
import { GenerationProgress } from '@/components/directories/detail/generator/GenerationProgress';
import { GenerateStatusType } from '@/lib/api/enums';
import { canGenerate } from '@/lib/permissions';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('generator') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryGeneratorPage({ params }: Params) {
    const { id } = await params;

    let directory;
    let config;

    try {
        const [directoryRes, configRes] = await Promise.all([
            directoryAPI.get(id),
            directoryAPI.getConfig(id).catch(() => ({ config: undefined })),
        ]);

        directory = directoryRes.directory;
        config = configRes.config;
    } catch {
        notFound();
    }

    // Server-side permission check: only editors+ can access generator
    if (!canGenerate(directory.userRole)) {
        notFound();
    }

    // If currently generating, show progress
    if (directory.generateStatus?.status === GenerateStatusType.GENERATING) {
        return <GenerationProgress directory={directory} />;
    }

    return <GeneratorForm directoryId={id} directory={directory} config={config} />;
}
