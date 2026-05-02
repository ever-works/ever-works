'use client';

import { useMemo, useState } from 'react';
import { PipelineModeSelector, ProviderSelector } from '../detail/generator/ProviderSelector';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';
import { useTranslations } from 'next-intl';
import type {
    GeneratorFormSchema,
    ProviderSelectionState,
    SelectableProviderCategory,
} from '@/lib/api/types-only';
import { getIndividualProviderCategories } from '@ever-works/plugin';
import { Sliders } from 'lucide-react';
import type { DirectoryPlugin } from '@/lib/api/plugins';
import { DirectoryPluginSettingsModal } from '../detail/plugins/DirectoryPluginSettingsModal';

interface ProviderSelectionSectionProps {
    directoryId?: string;
    formSchema: GeneratorFormSchema;
    providers: ProviderSelectionState;
    directoryPlugins?: DirectoryPlugin[];
    onProviderChange: (category: SelectableProviderCategory, value: string | null) => void;
}

export function ProviderSelectionSection({
    directoryId,
    formSchema,
    providers,
    directoryPlugins = [],
    onProviderChange,
}: ProviderSelectionSectionProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
    const settingsPlugin =
        directoryPlugins.find((plugin) => plugin.pluginId === settingsPluginId) ?? null;

    const individualCategories = getIndividualProviderCategories().filter(({ uiKey }) => {
        const options = formSchema.providers[uiKey as keyof GeneratorFormSchema['providers']];
        return options && options.length > 0;
    });
    const directoryPluginModelsById = useMemo(() => {
        return new Map(
            directoryPlugins
                .filter((plugin) => plugin.models?.length)
                .map((plugin) => [plugin.pluginId, plugin.models]),
        );
    }, [directoryPlugins]);

    return (
        <>
            {(formSchema.providers.pipeline?.length ?? 0) > 1 && (
                <PipelineModeSelector
                    pipelineProviders={formSchema.providers.pipeline}
                    selectedPipeline={providers.pipeline}
                    onChange={(pipelineId) => onProviderChange('pipeline', pipelineId)}
                />
            )}

            {individualCategories.length > 0 && (
                <Accordion type="single" collapsible defaultValue="open">
                    <AccordionItem
                        value="open"
                        className="rounded-lg border bg-card dark:bg-card-primary-dark/10 border-card-border dark:border-border-secondary-dark"
                    >
                        <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface-secondary/80 dark:hover:bg-surface-secondary-dark/80 bg-surface-secondary/50 dark:bg-transparent">
                            <div className="flex items-center gap-3">
                                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                                    <Sliders className="w-4 h-4 text-primary" />
                                </div>
                                <div className="text-left">
                                    <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-tight">
                                        {t('providerSelection')}
                                    </h3>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 font-normal">
                                        {t('providerSelectionDescription')}
                                    </p>
                                </div>
                            </div>
                        </AccordionTrigger>
                        <AccordionContent className="p-0">
                            <div className="divide-y divide-border dark:divide-border-dark">
                                {individualCategories.map(({ uiKey }) => {
                                    const options =
                                        formSchema.providers[
                                            uiKey as keyof GeneratorFormSchema['providers']
                                        ];

                                    const providerOptions =
                                        uiKey === 'ai'
                                            ? options.map((option) => ({
                                                  ...option,
                                                  models:
                                                      directoryPluginModelsById.get(option.id) ??
                                                      option.models,
                                              }))
                                            : options;

                                    const labelKey = `${uiKey}Provider` as Parameters<typeof t>[0];
                                    return (
                                        <ProviderSelector
                                            key={uiKey}
                                            label={t(labelKey)}
                                            providers={providerOptions}
                                            value={providers[uiKey as keyof ProviderSelectionState]}
                                            onConfigure={
                                                directoryId
                                                    ? (pluginId) => setSettingsPluginId(pluginId)
                                                    : undefined
                                            }
                                            onChange={(id) =>
                                                onProviderChange(
                                                    uiKey as SelectableProviderCategory,
                                                    id,
                                                )
                                            }
                                        />
                                    );
                                })}
                            </div>
                        </AccordionContent>
                    </AccordionItem>
                </Accordion>
            )}

            {directoryId && settingsPlugin && (
                <DirectoryPluginSettingsModal
                    open={settingsPluginId !== null}
                    onOpenChange={(open) => {
                        if (!open) setSettingsPluginId(null);
                    }}
                    directoryId={directoryId}
                    plugin={settingsPlugin}
                />
            )}
        </>
    );
}
