'use client';

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

interface ProviderSelectionSectionProps {
    formSchema: GeneratorFormSchema;
    providers: ProviderSelectionState;
    onProviderChange: (category: SelectableProviderCategory, value: string | null) => void;
}

export function ProviderSelectionSection({
    formSchema,
    providers,
    onProviderChange,
}: ProviderSelectionSectionProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    const individualCategories = getIndividualProviderCategories().filter(({ uiKey }) => {
        const options = formSchema.providers[uiKey as keyof GeneratorFormSchema['providers']];
        return options && options.length > 0;
    });

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
                        className="rounded-lg border bg-card dark:bg-card-primary-dark/30 border-card-border dark:border-card-border-dark"
                    >
                        <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface-secondary/80 dark:hover:bg-surface-secondary-dark/80 bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 border-b border-border dark:border-border-dark">
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
                                    const labelKey = `${uiKey}Provider` as Parameters<typeof t>[0];
                                    return (
                                        <ProviderSelector
                                            key={uiKey}
                                            label={t(labelKey)}
                                            providers={options}
                                            value={providers[uiKey as keyof ProviderSelectionState]}
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
        </>
    );
}
