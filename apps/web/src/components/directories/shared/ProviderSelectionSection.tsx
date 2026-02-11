'use client';

import { PipelineModeSelector, ProviderSelector } from '../detail/generator/ProviderSelector';
import { CollapsibleSection } from '../detail/shared';
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
    isFullPipeline: boolean;
}

export function ProviderSelectionSection({
    formSchema,
    providers,
    onProviderChange,
    isFullPipeline,
}: ProviderSelectionSectionProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    return (
        <>
            {formSchema.providers.fullPipeline.length > 0 && (
                <PipelineModeSelector
                    fullPipelineProviders={formSchema.providers.fullPipeline}
                    selectedPipeline={providers.pipeline}
                    onChange={(pipelineId) => onProviderChange('pipeline', pipelineId)}
                />
            )}

            {!isFullPipeline && (
                <CollapsibleSection
                    title={t('providerSelection')}
                    description={t('providerSelectionDescription')}
                    defaultExpanded={true}
                >
                    <div className="space-y-3">
                        {getIndividualProviderCategories().map(({ uiKey }) => {
                            const options =
                                formSchema.providers[
                                    uiKey as keyof GeneratorFormSchema['providers']
                                ];
                            if (!options || options.length === 0) return null;
                            const labelKey = `${uiKey}Provider` as Parameters<typeof t>[0];
                            return (
                                <ProviderSelector
                                    key={uiKey}
                                    label={t(labelKey)}
                                    providers={options}
                                    value={providers[uiKey as keyof ProviderSelectionState]}
                                    onChange={(id) =>
                                        onProviderChange(uiKey as SelectableProviderCategory, id)
                                    }
                                />
                            );
                        })}
                    </div>
                </CollapsibleSection>
            )}
        </>
    );
}
