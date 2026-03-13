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
                        className="rounded-lg border overflow-hidden bg-card dark:bg-card-primary-dark/30 border-card-border dark:border-card-border-dark"
                    >
                        <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-surface dark:hover:bg-surface-dark">
                            <div>
                                <h3 className="text-md font-semibold text-text dark:text-text-dark">
                                    {t('providerSelection')}
                                </h3>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 text-left font-normal">
                                    {t('providerSelectionDescription')}
                                </p>
                            </div>
                        </AccordionTrigger>
                        <AccordionContent className="px-6 pb-4 pt-2">
                            <div className="space-y-3">
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
