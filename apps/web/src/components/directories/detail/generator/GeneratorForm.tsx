'use client';

import { useState, useTransition } from 'react';
import {
    Directory,
    CreateItemsGeneratorDto,
    DirectoryConfig,
    UpdateItemsGeneratorDto,
} from '@/lib/api/types-only';
import { RequiredFields } from './RequiredFields';
import { UpdateItemsFields } from './UpdateItemsFields';
import { CompanyFields } from './CompanyFields';
import { CategoriesFields } from './CategoriesFields';
import { SourceFields } from './SourceFields';
import { ConfigFields } from './ConfigFields';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { generateItems, updateItems } from '@/app/actions/dashboard/generator';
import { useTranslations } from 'next-intl';
import { GenerationMethod, WebsiteRepositoryCreationMethod } from '@/lib/api/enums';

interface GeneratorFormProps {
    directoryId: string;
    directory: Directory;
    config?: DirectoryConfig;
}

export function GeneratorForm({ directoryId, directory, config }: GeneratorFormProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [isPending, startTransition] = useTransition();
    const [expandedSections, setExpandedSections] = useState<string[]>([]);
    const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);

    // Check if directory has been generated before
    const isGenerated = directory.generateStatus !== null && directory.generateStatus !== undefined;
    const initialPrompt = config?.metadata?.initial_prompt || '';
    const lastRequestData = config?.metadata?.last_request_data;

    const [formData, setFormData] = useState<CreateItemsGeneratorDto>({
        name: directory.name,
        prompt: initialPrompt,
        company: lastRequestData?.company || undefined,
        initial_categories: lastRequestData?.initial_categories || [],
        priority_categories: lastRequestData?.priority_categories || [],
        target_keywords: lastRequestData?.target_keywords || [],
        source_urls: lastRequestData?.source_urls || [],
        repository_description: lastRequestData?.repository_description || '',
        generation_method: lastRequestData?.generation_method || GenerationMethod.CREATE_UPDATE,
        update_with_pull_request:
            lastRequestData?.update_with_pull_request !== undefined
                ? lastRequestData.update_with_pull_request
                : true,
        badge_evaluation_enabled: lastRequestData?.badge_evaluation_enabled || false,
        website_repository_creation_method:
            lastRequestData?.website_repository_creation_method ||
            WebsiteRepositoryCreationMethod.DUPLICATE,
        config: lastRequestData?.config || {
            max_search_queries: 10,
            max_results_per_query: 5,
            max_pages_to_process: 10,
            relevance_threshold_content: 0.7,
            min_content_length_for_extraction: 100,
            ai_first_generation_enabled: true,
            content_filtering_enabled: true,
            prompt_comparison_confidence_threshold: 0.8,
        },
    });

    const toggleSection = (section: string) => {
        setExpandedSections((prev) =>
            prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section],
        );
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        startTransition(async () => {
            let result;

            // Minimal form (existing directory, not showing advanced options)
            // Uses update endpoint which doesn't require prompt
            if (
                isGenerated &&
                !showAdvancedOptions &&
                formData.generation_method !== GenerationMethod.RECREATE
            ) {
                const updateData: UpdateItemsGeneratorDto = {
                    generation_method: formData.generation_method,
                    update_with_pull_request: formData.update_with_pull_request,
                };
                result = await updateItems(directoryId, updateData);
            } else {
                // Full form: requires prompt for generate endpoint
                if (!formData.prompt.trim()) {
                    toast.error(t('promptRequired'));
                    return;
                }
                result = await generateItems(directoryId, formData);
            }

            if (result.success) {
                toast.success(result.message || t('operationStartedSuccessfully'));
                router.refresh();
            } else {
                toast.error(result.error || t('failedToStartOperation'));
            }
        });
    };

    // Determine button text based on context
    const getButtonText = () => {
        if (!isGenerated) {
            return t('startGeneration');
        }
        if (formData.generation_method === GenerationMethod.RECREATE) {
            return t('recreateDirectory');
        }
        return t('updateItems');
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
            {/* Show update fields for existing directories, full fields for new/expanded */}
            {isGenerated && !showAdvancedOptions ? (
                <UpdateItemsFields
                    generationMethod={formData.generation_method}
                    updateWithPullRequest={formData.update_with_pull_request}
                    onChange={(updates) => setFormData({ ...formData, ...updates })}
                />
            ) : (
                <RequiredFields
                    formData={formData}
                    onChange={(updates) => setFormData({ ...formData, ...updates })}
                />
            )}

            {/* Advanced Options Toggle for existing directories */}
            {isGenerated && (
                <div className="flex justify-end">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                        className="text-sm"
                    >
                        {showAdvancedOptions ? t('hideAdvancedOptions') : t('showAdvancedOptions')}
                    </Button>
                </div>
            )}

            {/* Show additional advanced options for new directories or when toggled */}
            {(!isGenerated || showAdvancedOptions) && (
                <>
                    {/* Company Information */}
                    <CollapsibleSection
                        title={t('companyInformation')}
                        description={t('companyInfoDescription')}
                        isExpanded={expandedSections.includes('company')}
                        onToggle={() => toggleSection('company')}
                    >
                        <CompanyFields
                            company={formData.company}
                            onChange={(company) => setFormData({ ...formData, company })}
                        />
                    </CollapsibleSection>

                    {/* Categories & Keywords */}
                    <CollapsibleSection
                        title={t('categoriesKeywords')}
                        description={t('categoriesDescription')}
                        isExpanded={expandedSections.includes('categories')}
                        onToggle={() => toggleSection('categories')}
                    >
                        <CategoriesFields
                            initialCategories={formData.initial_categories || []}
                            priorityCategories={formData.priority_categories || []}
                            targetKeywords={formData.target_keywords || []}
                            onChange={(updates) => setFormData({ ...formData, ...updates })}
                        />
                    </CollapsibleSection>

                    {/* Source URLs */}
                    <CollapsibleSection
                        title={t('sourceUrls')}
                        description={t('sourceUrlsDescription')}
                        isExpanded={expandedSections.includes('sources')}
                        onToggle={() => toggleSection('sources')}
                    >
                        <SourceFields
                            sourceUrls={formData.source_urls || []}
                            onChange={(source_urls) => setFormData({ ...formData, source_urls })}
                        />
                    </CollapsibleSection>

                    {/* Advanced Configuration */}
                    <CollapsibleSection
                        title={t('advancedConfig')}
                        description={t('advancedConfigDescription')}
                        isExpanded={expandedSections.includes('config')}
                        onToggle={() => toggleSection('config')}
                    >
                        <ConfigFields
                            config={formData.config}
                            generationMethod={formData.generation_method}
                            updateWithPullRequest={formData.update_with_pull_request || false}
                            badgeEvaluationEnabled={formData.badge_evaluation_enabled || false}
                            websiteRepositoryCreationMethod={
                                formData.website_repository_creation_method
                            }
                            onChange={(updates) => setFormData({ ...formData, ...updates })}
                        />
                    </CollapsibleSection>
                </>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-6">
                <Button
                    type="submit"
                    disabled={isPending}
                    loading={isPending}
                    variant="primary"
                    size="lg"
                >
                    {getButtonText()}
                </Button>
                <Button
                    type="button"
                    onClick={() => router.back()}
                    disabled={isPending}
                    variant="secondary"
                    size="lg"
                >
                    {t('cancel')}
                </Button>
            </div>
        </form>
    );
}

interface CollapsibleSectionProps {
    title: string;
    description: string;
    isExpanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

function CollapsibleSection({
    title,
    description,
    isExpanded,
    onToggle,
    children,
}: CollapsibleSectionProps) {
    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <button
                type="button"
                onClick={onToggle}
                className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-surface dark:hover:bg-surface-dark transition-colors"
            >
                <div>
                    <h3 className="text-lg font-medium text-text dark:text-text-dark">{title}</h3>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {description}
                    </p>
                </div>
                <svg
                    className={cn(
                        'w-5 h-5 text-text-secondary dark:text-text-secondary-dark transition-transform',
                        isExpanded && 'rotate-180',
                    )}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                    />
                </svg>
            </button>
            {isExpanded && <div className="px-6 pb-4 pt-2">{children}</div>}
        </div>
    );
}
