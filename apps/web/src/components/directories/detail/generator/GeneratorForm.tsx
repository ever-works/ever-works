'use client';

import { useState, useTransition } from 'react';
import { Directory } from '@/lib/api';
import { CreateItemsGeneratorDto, GenerationMethod, WebsiteRepositoryCreationMethod } from '@/lib/api/items-generator';
import { RequiredFields } from './RequiredFields';
import { CompanyFields } from './CompanyFields';
import { CategoriesFields } from './CategoriesFields';
import { SourceFields } from './SourceFields';
import { ConfigFields } from './ConfigFields';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { generateItems } from '@/app/actions/dashboard/generator';
import { useTranslations } from 'next-intl';

interface GeneratorFormProps {
    directoryId: string;
    directory: Directory;
}

export function GeneratorForm({ directoryId, directory }: GeneratorFormProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [isPending, startTransition] = useTransition();
    const [expandedSections, setExpandedSections] = useState<string[]>([]);

    const [formData, setFormData] = useState<CreateItemsGeneratorDto>({
        name: directory.name,
        prompt: '',
        company: undefined,
        initial_categories: [],
        priority_categories: [],
        target_keywords: [],
        source_urls: [],
        repository_description: '',
        generation_method: GenerationMethod.CREATE_UPDATE,
        update_with_pull_request: false,
        badge_evaluation_enabled: true,
        website_repository_creation_method: WebsiteRepositoryCreationMethod.DUPLICATE,
        config: {
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
        setExpandedSections(prev =>
            prev.includes(section)
                ? prev.filter(s => s !== section)
                : [...prev, section]
        );
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.prompt.trim()) {
            toast.error('Prompt is required');
            return;
        }

        startTransition(async () => {
            const result = await generateItems(directoryId, formData);

            if (result.success) {
                toast.success('Generation started successfully');
                router.refresh();
            } else {
                toast.error(result.error || 'Failed to start generation');
            }
        });
    };

    const hasExistingGeneration = directory.generateStatus !== null && directory.generateStatus !== undefined;

    return (
        <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
            {/* Status Alert */}
            {hasExistingGeneration && (
                <div className={cn(
                    'rounded-lg border p-4',
                    'bg-amber-50 dark:bg-amber-900/20',
                    'border-amber-200 dark:border-amber-800',
                )}>
                    <div className="flex gap-3">
                        <svg className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <div>
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                                {t('regenerationWarning')}
                            </p>
                            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                                {t('regenerationWarningDescription')}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Required Fields */}
            <RequiredFields
                formData={formData}
                onChange={(updates) => setFormData({ ...formData, ...updates })}
            />

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
                    websiteRepositoryCreationMethod={formData.website_repository_creation_method}
                    onChange={(updates) => setFormData({ ...formData, ...updates })}
                />
            </CollapsibleSection>

            {/* Actions */}
            <div className="flex gap-3 pt-6">
                <Button
                    type="submit"
                    disabled={isPending}
                    loading={isPending}
                    variant="primary"
                    size="lg"
                >
                    {hasExistingGeneration ? t('regenerateItems') : t('startGeneration')}
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

function CollapsibleSection({ title, description, isExpanded, onToggle, children }: CollapsibleSectionProps) {
    return (
        <div className={cn(
            'rounded-lg border',
            'bg-card dark:bg-card-dark',
            'border-card-border dark:border-card-border-dark',
        )}>
            <button
                type="button"
                onClick={onToggle}
                className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-surface dark:hover:bg-surface-dark transition-colors"
            >
                <div>
                    <h3 className="text-lg font-medium text-text dark:text-text-dark">
                        {title}
                    </h3>
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
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            {isExpanded && (
                <div className="px-6 pb-4">
                    {children}
                </div>
            )}
        </div>
    );
}