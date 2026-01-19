'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { toast } from 'sonner';
import { getAdvancedPrompts, updateAdvancedPrompts } from '@/app/actions/dashboard/directories';
import { DirectoryAdvancedPrompts } from '@/lib/api/directory';

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

    const [isExpanded, setIsExpanded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
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

    // Load advanced prompts when expanded for the first time
    useEffect(() => {
        if (isExpanded && !isLoading) {
            loadAdvancedPrompts();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isExpanded]);

    const loadAdvancedPrompts = async () => {
        setIsLoading(true);
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
        } catch (error) {
            console.error('Failed to load advanced prompts:', error);
        } finally {
            setIsLoading(false);
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

    const handleFieldChange = (field: PromptFieldKey, value: string) => {
        setFormData((prev) => ({
            ...prev,
            [field]: value,
        }));
    };

    return (
        <div
            className={cn(
                'rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            {/* Collapsible Header */}
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-6 flex items-center justify-between text-left hover:bg-muted/50 dark:hover:bg-muted-dark/50 transition-colors rounded-lg"
            >
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {isExpanded ? (
                    <ChevronUpIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                ) : (
                    <ChevronDownIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                )}
            </button>

            {/* Expandable Content */}
            {isExpanded && (
                <div className="px-6 pb-6 space-y-6">
                    {isLoading ? (
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
                                        onChange={(e) => handleFieldChange(field, e.target.value)}
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
            )}
        </div>
    );
}
