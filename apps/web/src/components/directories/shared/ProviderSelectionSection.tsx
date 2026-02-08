'use client';

import { PipelineModeSelector, ProviderSelector } from '../detail/generator/ProviderSelector';
import { CollapsibleSection } from '../detail/shared';
import { useTranslations } from 'next-intl';
import type {
    GeneratorFormSchema,
    ProviderSelectionState,
    SelectableProviderCategory,
} from '@/lib/api/types-only';

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
            {formSchema.providers.fullPipeline.length > 1 && (
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
                        {formSchema.providers.search.length > 0 && (
                            <ProviderSelector
                                label={t('searchProvider')}
                                providers={formSchema.providers.search}
                                value={providers.search}
                                onChange={(id) => onProviderChange('search', id)}
                            />
                        )}
                        {formSchema.providers.screenshot.length > 0 && (
                            <ProviderSelector
                                label={t('screenshotProvider')}
                                providers={formSchema.providers.screenshot}
                                value={providers.screenshot}
                                onChange={(id) => onProviderChange('screenshot', id)}
                            />
                        )}
                        {formSchema.providers.ai.length > 0 && (
                            <ProviderSelector
                                label={t('aiProvider')}
                                providers={formSchema.providers.ai}
                                value={providers.ai}
                                onChange={(id) => onProviderChange('ai', id)}
                            />
                        )}
                        {formSchema.providers.contentExtractor.length > 0 && (
                            <ProviderSelector
                                label={t('contentExtractorProvider')}
                                providers={formSchema.providers.contentExtractor}
                                value={providers.contentExtractor}
                                onChange={(id) => onProviderChange('contentExtractor', id)}
                            />
                        )}
                    </div>
                </CollapsibleSection>
            )}
        </>
    );
}
