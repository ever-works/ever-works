import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Zap } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { TriggerDetailClient } from '@/components/tasks/TriggerDetailClient';
import { inboundTriggersAPI } from '@/lib/api/inbound-triggers';
import { resolvePublicApiBaseUrl } from '@/lib/fleet-flags';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.taskTriggers.detail');
    return { title: t('title') };
}

/**
 * One trigger: webhook management (URL, signed curl example, secret
 * rotation), the manual Fire now / Pause controls, and the recent-fires
 * log. The API 404s a trigger the caller does not own, which surfaces
 * here as a normal not-found page rather than an error boundary.
 */
export default async function TaskTriggerDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const trigger = await inboundTriggersAPI.getOne(id).catch(() => null);
    if (!trigger) notFound();
    const fires = await inboundTriggersAPI.listFires(id).catch(() => []);

    return (
        <div className="w-full">
            <PageHeader
                icon={Zap}
                title={trigger.name}
                subtitle={trigger.description ?? undefined}
                tone="task"
            />
            <TriggerDetailClient
                trigger={trigger}
                initialFires={fires}
                apiBaseUrl={resolvePublicApiBaseUrl()}
            />
        </div>
    );
}
