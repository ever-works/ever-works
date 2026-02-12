import { directoryAPI, itemsGeneratorAPI } from '@/lib/api';
import {
    DirectoryScheduleCard,
    type ResolvedProvider,
} from '@/components/directories/detail/schedule/DirectoryScheduleCard';
import { DirectoryScheduleHeader } from '@/components/directories/detail/schedule/DirectoryScheduleHeader';
import { canManageSchedule } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import type { ProviderOption } from '@/lib/api/types-only';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { SELECTABLE_PROVIDER_CATEGORIES, type ProviderCategoryKey } from '@ever-works/plugin';

type Params = { params: Promise<{ id: string }> };

function resolveActiveProviders(
    lastRunProviders: ProvidersDto | undefined,
    overrides: ProvidersDto | null | undefined,
    allProviders: Record<string, ProviderOption[]>,
): ResolvedProvider[] {
    const scheduleLabels: Record<ProviderCategoryKey, string> = {
        pipeline: 'Pipeline',
        ai: 'AI',
        search: 'Search',
        screenshot: 'Screenshot',
        contentExtractor: 'Extractor',
    };
    const categories = Object.entries(SELECTABLE_PROVIDER_CATEGORIES).map(([key, def]) => ({
        key: def.uiKey as keyof ProvidersDto,
        label: scheduleLabels[key as ProviderCategoryKey],
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

    const [directoryRes, scheduleRes, formSchema, configRes] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getSchedule(id).catch(() => null),
        itemsGeneratorAPI.getFormSchema(id).catch(() => null),
        directoryAPI.getConfig(id).catch(() => null),
    ]);

    const directory = directoryRes.directory;

    if (!canManageSchedule(directory.userRole)) {
        notFound();
    }

    const pipelineProviders = formSchema?.providers?.pipeline ?? [];
    const lastRunProviders = configRes?.config?.metadata?.last_request_data?.providers;
    const schedule = scheduleRes?.schedule || null;

    const activeProviders = resolveActiveProviders(
        lastRunProviders,
        schedule?.providerOverrides,
        formSchema?.providers ?? {},
    );

    return (
        <div className="space-y-6">
            <DirectoryScheduleHeader />

            <DirectoryScheduleCard
                schedule={schedule}
                pipelineProviders={pipelineProviders}
                activeProviders={activeProviders}
            />
        </div>
    );
}
