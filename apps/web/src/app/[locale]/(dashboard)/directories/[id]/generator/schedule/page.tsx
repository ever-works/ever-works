import { directoryAPI, itemsGeneratorAPI } from '@/lib/api';
import {
    DirectoryScheduleCard,
    type ResolvedProvider,
} from '@/components/directories/detail/schedule/DirectoryScheduleCard';
import { DirectoryScheduleHeader } from '@/components/directories/detail/schedule/DirectoryScheduleHeader';
import { canManageSchedule } from '@/lib/permissions';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { GeneratorFormSchema, ProviderOption } from '@/lib/api/types-only';
import type { ProvidersDto } from '@ever-works/contracts/api';
import {
    buildSelectedProviders,
    SELECTABLE_PROVIDER_CATEGORIES,
    type ProviderCategoryKey,
} from '@ever-works/plugin';

type Params = { params: Promise<{ id: string }> };

function resolveActiveProviders(
    overrides: ProvidersDto | null | undefined,
    formSchema: GeneratorFormSchema | null,
    labels: Record<ProviderCategoryKey, string>,
): ResolvedProvider[] {
    if (!formSchema) {
        return [];
    }

    const selectedProviders = buildSelectedProviders(overrides ?? {}, formSchema) as
        | ProvidersDto
        | undefined;
    if (!selectedProviders) {
        return [];
    }

    const allProviders = formSchema.providers;
    const categories = Object.entries(SELECTABLE_PROVIDER_CATEGORIES).map(([key, def]) => ({
        key: def.uiKey as keyof ProvidersDto,
        label: labels[key as ProviderCategoryKey],
        options: allProviders[def.uiKey],
    }));

    const result: ResolvedProvider[] = [];
    for (const { key, label, options } of categories) {
        const overrideId = overrides?.[key];
        const activeId = selectedProviders[key];
        if (!activeId) continue;

        const name = options?.find((p) => p.id === activeId)?.name ?? activeId;
        result.push({
            category: label,
            id: activeId,
            name,
            source: overrideId ? 'override' : 'default',
        });
    }
    return result;
}

export default async function DirectorySchedulePage({ params }: Params) {
    const { id } = await params;
    const t = await getTranslations('dashboard.directoryDetail.schedule.page');

    let directory;
    let formSchema;
    let scheduleRes = null;
    let scheduleErrorMessage: string | null = null;

    try {
        const directoryResult = await directoryAPI.get(id);
        directory = directoryResult.directory;
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

    const schedule = scheduleRes?.schedule || null;
    formSchema = await itemsGeneratorAPI
        .getFormSchema(id, schedule?.providerOverrides?.pipeline)
        .catch(() => null);

    const pipelineProviders = formSchema?.providers?.pipeline ?? [];

    const providerLabels: Record<ProviderCategoryKey, string> = {
        pipeline: t('providerCategories.pipeline'),
        ai: t('providerCategories.ai'),
        search: t('providerCategories.search'),
        screenshot: t('providerCategories.screenshot'),
        contentExtractor: t('providerCategories.contentExtractor'),
    };

    const activeProviders = resolveActiveProviders(
        schedule?.providerOverrides,
        formSchema,
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
