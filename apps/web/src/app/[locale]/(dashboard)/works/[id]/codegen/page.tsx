import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { codeUpdateAPI, workAPI, type WorkCodeUpdate } from '@/lib/api';
import { CodegenPanel } from '@/components/works/detail/codegen/CodegenPanel';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('codegen') };
}

type CodegenPageParams = {
    params: Promise<{ id: string }>;
};

export default async function CodegenPage({ params }: CodegenPageParams) {
    const { id } = await params;

    const workRes = await workAPI.get(id).catch(() => null);
    if (!workRes?.work) notFound();

    let codeUpdates: WorkCodeUpdate[] = [];
    try {
        const res = await codeUpdateAPI.list(id);
        codeUpdates = res?.codeUpdates ?? [];
    } catch {
        // Empty list is acceptable on first visit.
    }

    return <CodegenPanel workId={id} initialCodeUpdates={codeUpdates} />;
}
