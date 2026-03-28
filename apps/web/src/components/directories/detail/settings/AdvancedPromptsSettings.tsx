'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Button } from '@/components/ui/button';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';
import { toast } from 'sonner';
import { getAdvancedPrompts, updateAdvancedPrompts } from '@/app/actions/dashboard/directories';
import { DirectoryAdvancedPrompts } from '@/lib/api/directory';
import {
    getComparisonAiConfig,
    saveComparisonCustomPrompt,
} from '@/app/actions/dashboard/comparisons';

interface AdvancedPromptsSettingsProps {
    directoryId: string;
}

// Prompt configuration for each field
const PROMPT_FIELDS = [
    'relevanceAssessment',
    'itemGeneration',
    'itemExtraction',
    'searchQuery',
    'categorization',
    'deduplication',
    'sourceValidation',
] as const;

type PromptFieldKey = (typeof PROMPT_FIELDS)[number];

type FormData = {
    [K in PromptFieldKey]: string;
};

export function AdvancedPromptsSettings({ directoryId }: AdvancedPromptsSettingsProps) {
    const t = useTranslations('dashboard.directoryDetail.settings.advancedPrompts');

    // Standard Pipeline state
    const [isStandardExpanded, setIsStandardExpanded] = useState(false);
    const [isStandardLoading, setIsStandardLoading] = useState(false);
    const [isStandardLoaded, setIsStandardLoaded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [formData, setFormData] = useState<FormData>({
        relevanceAssessment: '',
        itemGeneration: '',
        itemExtraction: '',
        searchQuery: '',
        categorization: '',
        deduplication: '',
        sourceValidation: '',
    });

    // Comparison state
    const [isComparisonExpanded, setIsComparisonExpanded] = useState(false);
    const [isComparisonLoading, setIsComparisonLoading] = useState(false);
    const [isComparisonLoaded, setIsComparisonLoaded] = useState(false);
    const [isSavingComparison, setIsSavingComparison] = useState(false);
    const [comparisonPrompt, setComparisonPrompt] = useState('');

    // Load standard pipeline prompts when expanded for the first time
    useEffect(() => {
        if (isStandardExpanded && !isStandardLoaded && !isStandardLoading) {
            loadStandardPrompts();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isStandardExpanded]);

    // Load comparison prompt when expanded for the first time
    useEffect(() => {
        if (isComparisonExpanded && !isComparisonLoaded && !isComparisonLoading) {
            loadComparisonPrompt();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isComparisonExpanded]);

    const loadStandardPrompts = async () => {
        setIsStandardLoading(true);
        try {
            const result = await getAdvancedPrompts(directoryId);

            if (result.success && result.data) {
                const data = result.data as DirectoryAdvancedPrompts;
                setFormData({
                    relevanceAssessment: data.relevanceAssessment || '',
                    itemGeneration: data.itemGeneration || '',
                    itemExtraction: data.itemExtraction || '',
                    searchQuery: data.searchQuery || '',
                    categorization: data.categorization || '',
                    deduplication: data.deduplication || '',
                    sourceValidation: data.sourceValidation || '',
                });
            }

            setIsStandardLoaded(true);
        } catch (error) {
            console.error('Failed to load advanced prompts:', error);
        } finally {
            setIsStandardLoading(false);
        }
    };

    const loadComparisonPrompt = async () => {
        setIsComparisonLoading(true);
        try {
            const comparisonConfig = await getComparisonAiConfig(directoryId);
            setComparisonPrompt(comparisonConfig.currentConfig.customPrompt || '');
            setIsComparisonLoaded(true);
        } catch (error) {
            console.error('Failed to load comparison prompt:', error);
        } finally {
            setIsComparisonLoading(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            // Convert empty strings to null for the API
            const dataToSave = Object.fromEntries(
                Object.entries(formData).map(([key, value]) => [
                    key,
                    value.trim() === '' ? null : value.trim(),
                ]),
            );

            const result = await updateAdvancedPrompts(directoryId, dataToSave);

            if (result.success) {
                toast.success(t('saveSuccess'));
            } else {
                toast.error(result.error || t('saveFailed'));
            }
        } catch (error) {
            console.error('Failed to save advanced prompts:', error);
            toast.error(t('saveFailed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveComparison = async () => {
        setIsSavingComparison(true);
        try {
            const result = await saveComparisonCustomPrompt(
                directoryId,
                comparisonPrompt.trim() || null,
            );

            if (result.success) {
                toast.success(t('saveComparisonSuccess'));
            } else {
                toast.error(result.error || t('saveFailed'));
            }
        } catch (error) {
            console.error('Failed to save comparison prompt:', error);
            toast.error(t('saveFailed'));
        } finally {
            setIsSavingComparison(false);
        }
    };

    const handleFieldChange = (field: PromptFieldKey, value: string) => {
        setFormData((prev) => ({
            ...prev,
            [field]: value,
        }));
    };

    const handleAccordionChange = (value: string[]) => {
        const wasStandardClosed = isStandardExpanded && !value.includes('standard');
        const wasStandardOpened = !isStandardExpanded && value.includes('standard');
        const wasComparisonClosed = isComparisonExpanded && !value.includes('comparison');
        const wasComparisonOpened = !isComparisonExpanded && value.includes('comparison');

        if (wasStandardOpened) setIsStandardExpanded(true);
        if (wasStandardClosed) setIsStandardExpanded(false);
        if (wasComparisonOpened) setIsComparisonExpanded(true);
        if (wasComparisonClosed) setIsComparisonExpanded(false);
    };

    return (
        <Accordion type="multiple" onValueChange={handleAccordionChange} className="space-y-3">
            {/* Standard Pipeline Card */}
            <AccordionItem
                value="standard"
                className={cn(
                    'rounded-lg border overflow-hidden',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-border-secondary-dark',
                )}
            >
                <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface/50 dark:hover:bg-surface-dark/50">
                    <div className="text-left">
                        <span className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </span>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 font-normal">
                            {t('subtitle')}
                        </p>
                    </div>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-4 pt-2">
                    <div className="space-y-4">
                        {isStandardLoading ? (
                            <div className="flex justify-center py-8">
                                <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
                            </div>
                        ) : (
                            <>
                                {PROMPT_FIELDS.map((field) => (
                                    <div key={field} className="space-y-2">
                                        <AutoResizeTextarea
                                            label={t(`prompts.${field}.title`)}
                                            value={formData[field]}
                                            onChange={(e) =>
                                                handleFieldChange(field, e.target.value)
                                            }
                                            placeholder={t(`prompts.${field}.placeholder`)}
                                            rows={3}
                                            variant="form"
                                            minRows={2}
                                            maxHeight={200}
                                            maxLength={2000}
                                        />
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t(`prompts.${field}.description`)}
                                        </p>
                                    </div>
                                ))}

                                <Button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    loading={isSaving}
                                    variant="secondary"
                                >
                                    {t('save')}
                                </Button>
                            </>
                        )}
                    </div>
                </AccordionContent>
            </AccordionItem>

            {/* Comparison Card */}
            <AccordionItem
                value="comparison"
                className={cn(
                    'rounded-lg border overflow-hidden',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-border-secondary-dark',
                )}
            >
                <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface/50 dark:hover:bg-surface-dark/50">
                    <div className="text-left">
                        <span className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('comparisonTitle')}
                        </span>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 font-normal">
                            {t('comparisonSubtitle')}
                        </p>
                    </div>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-4 pt-2">
                    <div className="space-y-4">
                        {isComparisonLoading ? (
                            <div className="flex justify-center py-8">
                                <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
                            </div>
                        ) : (
                            <>
                                <div className="space-y-2">
                                    <AutoResizeTextarea
                                        label={t('prompts.comparisonCustomPrompt.title')}
                                        value={comparisonPrompt}
                                        onChange={(e) => setComparisonPrompt(e.target.value)}
                                        placeholder={t(
                                            'prompts.comparisonCustomPrompt.placeholder',
                                        )}
                                        rows={3}
                                        variant="form"
                                        minRows={2}
                                        maxHeight={200}
                                        maxLength={2000}
                                    />
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('prompts.comparisonCustomPrompt.description')}
                                    </p>
                                </div>

                                <Button
                                    type="button"
                                    onClick={handleSaveComparison}
                                    disabled={isSavingComparison}
                                    loading={isSavingComparison}
                                    variant="secondary"
                                >
                                    {t('save')}
                                </Button>
                            </>
                        )}
                    </div>
                </AccordionContent>
            </AccordionItem>
        </Accordion>
    );
}
