import { directoryAPI, itemsGeneratorAPI } from '@/lib/api';
import {
    DirectoryScheduleCard,
    type ResolvedProvider,
} from '@/components/directories/detail/schedule/DirectoryScheduleCard';
import { DirectoryScheduleHeader } from '@/components/directories/detail/schedule/DirectoryScheduleHeader';
import { canManageSchedule } from '@/lib/permissions';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ProviderOption } from '@/lib/api/types-only';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { SELECTABLE_PROVIDER_CATEGORIES, type ProviderCategoryKey } from '@ever-works/plugin';

type Params = { params: Promise<{ id: string }> };

function resolveActiveProviders(
    lastRunProviders: ProvidersDto | undefined,
    overrides: ProvidersDto | null | undefined,
    allProviders: Record<string, ProviderOption[]>,
    labels: Record<ProviderCategoryKey, string>,
): ResolvedProvider[] {
    const categories = Object.entries(SELECTABLE_PROVIDER_CATEGORIES).map(([key, def]) => ({
        key: def.uiKey as keyof ProvidersDto,
        label: labels[key as ProviderCategoryKey],
        options: allProviders[def.uiKey],
    }));

    const result: ResolvedProvider[] = [];
    for (const { key, label, options } of categories) {
        const overrideId = overrides?.[key];
        const lastRunId = lastRunProviders?.[key];
        const activeId = overrideId ?? lastRunId;
        if (!activeId) continue;

        const name = options?.find((p) => p.id === activeId)?.name ?? activeId;
        result.push({
            category: label,
            id: activeId,
            name,
            source: overrideId ? 'override' : 'lastRun',
        });
    }
    return result;
}

export default async function DirectorySchedulePage({ params }: Params) {
    const { id } = await params;
    const t = await getTranslations('dashboard.directoryDetail.schedule.page');

    let directory;
    let formSchema;
    let configRes;
    let scheduleRes = null;
    let scheduleErrorMessage: string | null = null;

    try {
        const [directoryResult, formSchemaResult, configResult] = await Promise.all([
            directoryAPI.get(id),
            itemsGeneratorAPI.getFormSchema(id).catch(() => null),
            directoryAPI.getConfig(id).catch(() => null),
        ]);

        directory = directoryResult.directory;
        formSchema = formSchemaResult;
        configRes = configResult;
    } catch {
        notFound();
    }

    try {
        scheduleRes = await directoryAPI.getSchedule(id);
    } catch (error) {
        scheduleErrorMessage = error instanceof Error ? error.message : t('loadFailed');
    }

    if (!canManageSchedule(directory.userRole)) {
        notFound();
    }

    const pipelineProviders = formSchema?.providers?.pipeline ?? [];
    const lastRunProviders = configRes?.config?.metadata?.last_request_data?.providers;
    const schedule = scheduleRes?.schedule || null;

    const providerLabels: Record<ProviderCategoryKey, string> = {
        pipeline: t('providerCategories.pipeline'),
        ai: t('providerCategories.ai'),
        search: t('providerCategories.search'),
        screenshot: t('providerCategories.screenshot'),
        contentExtractor: t('providerCategories.contentExtractor'),
    };

    const activeProviders = resolveActiveProviders(
        lastRunProviders,
        schedule?.providerOverrides,
        formSchema?.providers ?? {},
        providerLabels,
    );

    return (
        <div className="space-y-6">
            <DirectoryScheduleHeader />

            <DirectoryScheduleCard
                schedule={schedule}
                errorMessage={scheduleErrorMessage}
                pipelineProviders={pipelineProviders}
                activeProviders={activeProviders}
            />
        </div>
    );
}
