'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ConfigDto, GenerationMethod, WebsiteRepositoryCreationMethod } from '@/lib/api/items-generator';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface ConfigFieldsProps {
    config?: ConfigDto;
    generationMethod?: GenerationMethod;
    updateWithPullRequest?: boolean;
    badgeEvaluationEnabled?: boolean;
    websiteRepositoryCreationMethod?: WebsiteRepositoryCreationMethod;
    onChange: (updates: Partial<{
        config?: ConfigDto;
        generation_method?: GenerationMethod;
        update_with_pull_request?: boolean;
        badge_evaluation_enabled?: boolean;
        website_repository_creation_method?: WebsiteRepositoryCreationMethod;
    }>) => void;
}

export function ConfigFields({
    config,
    generationMethod,
    updateWithPullRequest,
    badgeEvaluationEnabled,
    websiteRepositoryCreationMethod,
    onChange,
}: ConfigFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    return (
        <div className="space-y-6">
            {/* Generation Method */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                    {t('generationMethod')}
                </label>
                <select
                    value={generationMethod}
                    onChange={(e) => onChange({ generation_method: e.target.value as GenerationMethod })}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border text-sm',
                        'bg-surface dark:bg-surface-dark',
                        'border-border dark:border-border-dark',
                        'text-text dark:text-text-dark',
                    )}
                >
                    <option value={GenerationMethod.CREATE_UPDATE}>{t('methodCreateUpdate')}</option>
                    <option value={GenerationMethod.RECREATE}>{t('methodRecreate')}</option>
                </select>
            </div>

            {/* Checkboxes */}
            <div className="space-y-3">
                <Checkbox
                    checked={updateWithPullRequest || false}
                    onChange={(e) => onChange({ update_with_pull_request: e.target.checked })}
                    label={t('updateWithPullRequest')}
                    description={t('updateWithPullRequestDescription')}
                    variant="form"
                />

                <Checkbox
                    checked={badgeEvaluationEnabled || false}
                    onChange={(e) => onChange({ badge_evaluation_enabled: e.target.checked })}
                    label={t('enableBadgeEvaluation')}
                    description={t('enableBadgeEvaluationDescription')}
                    variant="form"
                />
            </div>

            {/* Website Repository Method */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                    {t('websiteRepositoryCreationMethod')}
                </label>
                <select
                    value={websiteRepositoryCreationMethod}
                    onChange={(e) => onChange({ website_repository_creation_method: e.target.value as WebsiteRepositoryCreationMethod })}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border text-sm',
                        'bg-surface dark:bg-surface-dark',
                        'border-border dark:border-border-dark',
                        'text-text dark:text-text-dark',
                    )}
                >
                    <option value={WebsiteRepositoryCreationMethod.DUPLICATE}>{t('methodDuplicate')}</option>
                    <option value={WebsiteRepositoryCreationMethod.FORK}>{t('methodFork')}</option>
                    <option value={WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE}>{t('methodCreateFromTemplate')}</option>
                </select>
            </div>

            {/* AI Configuration */}
            <div className="space-y-4">
                <h4 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('aiProcessingConfiguration')}
                </h4>

                <div className="grid sm:grid-cols-2 gap-4">
                    <Input
                        label={t('maxSearchQueries')}
                        type="number"
                        value={config?.max_search_queries || 10}
                        onChange={(e) => onChange({
                            config: { ...config, max_search_queries: parseInt(e.target.value) || 10 }
                        })}
                        variant="form"
                        min="1"
                        max="50"
                    />

                    <Input
                        label={t('resultsPerQuery')}
                        type="number"
                        value={config?.max_results_per_query || 5}
                        onChange={(e) => onChange({
                            config: { ...config, max_results_per_query: parseInt(e.target.value) || 5 }
                        })}
                        variant="form"
                        min="1"
                        max="20"
                    />

                    <Input
                        label={t('maxPagesToProcess')}
                        type="number"
                        value={config?.max_pages_to_process || 10}
                        onChange={(e) => onChange({
                            config: { ...config, max_pages_to_process: parseInt(e.target.value) || 10 }
                        })}
                        variant="form"
                        min="1"
                        max="100"
                    />

                    <Input
                        label={t('relevanceThreshold')}
                        type="number"
                        step="0.1"
                        value={config?.relevance_threshold_content || 0.7}
                        onChange={(e) => onChange({
                            config: { ...config, relevance_threshold_content: parseFloat(e.target.value) || 0.7 }
                        })}
                        variant="form"
                        min="0"
                        max="1"
                    />
                </div>

                <div className="space-y-3">
                    <Checkbox
                        checked={config?.ai_first_generation_enabled || false}
                        onChange={(e) => onChange({
                            config: { ...config, ai_first_generation_enabled: e.target.checked }
                        })}
                        label={t('aiFirstGeneration')}
                        description={t('aiFirstGenerationDescription')}
                        variant="form"
                    />

                    <Checkbox
                        checked={config?.content_filtering_enabled || false}
                        onChange={(e) => onChange({
                            config: { ...config, content_filtering_enabled: e.target.checked }
                        })}
                        label={t('contentFiltering')}
                        description={t('contentFilteringDescription')}
                        variant="form"
                    />
                </div>
            </div>
        </div>
    );
}