'use client';

import { memo, KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';

interface CategoriesFieldProps {
    existingCategories: string[];
    selectedCategories: string[];
    categoryInput: string;
    setCategoryInput: (value: string) => void;
    onAddCategory: (category: string) => void;
    onRemoveCategory: (category: string) => void;
    isPending: boolean;
}

export const CategoriesField = memo(function CategoriesField({
    existingCategories,
    selectedCategories,
    categoryInput,
    setCategoryInput,
    onAddCategory,
    onRemoveCategory,
    isPending,
}: CategoriesFieldProps) {
    const t = useTranslations('dashboard.directoryDetail.items.addModal');

    const handleAddFromInput = () => {
        if (categoryInput.trim() && !selectedCategories.includes(categoryInput.trim())) {
            onAddCategory(categoryInput.trim());
            setCategoryInput('');
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddFromInput();
        }
    };

    // Filter out already selected categories from suggestions
    const availableSuggestions = existingCategories.filter(
        (cat) => !selectedCategories.includes(cat),
    );

    return (
        <div className="space-y-3">
            <label className="text-sm font-medium text-text dark:text-text-dark">
                {t('categories')} *
            </label>

            {/* Selected categories */}
            {selectedCategories.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {selectedCategories.map((category) => (
                        <span
                            key={category}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs',
                                'bg-primary/10 dark:bg-primary-dark/10',
                                'text-primary dark:text-primary-dark',
                            )}
                        >
                            {category}
                            <button
                                type="button"
                                onClick={() => onRemoveCategory(category)}
                                className="hover:opacity-70"
                                disabled={isPending}
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {/* Existing categories suggestions */}
            {availableSuggestions.length > 0 && (
                <div className="space-y-1.5">
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('existingCategories')}
                    </span>
                    <div className="flex flex-wrap gap-2">
                        {availableSuggestions.map((category) => (
                            <button
                                key={category}
                                type="button"
                                onClick={() => onAddCategory(category)}
                                disabled={isPending}
                                className={cn(
                                    'px-2 py-1 rounded-lg text-xs',
                                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                                    'text-text dark:text-text-dark',
                                    'border border-border dark:border-border-dark',
                                    'hover:bg-surface-hover dark:hover:bg-surface-hover-dark',
                                    'hover:border-primary dark:hover:border-primary-dark',
                                    'transition-colors',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                + {category}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Add new category input */}
            <div className="space-y-1.5">
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('addNewCategory')}
                </span>
                <div className="flex gap-2">
                    <Input
                        type="text"
                        value={categoryInput}
                        onChange={(e) => setCategoryInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('categoryPlaceholder')}
                        variant="form"
                        className="flex-1"
                        disabled={isPending}
                    />
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={handleAddFromInput}
                        disabled={isPending || !categoryInput.trim()}
                    >
                        <Plus className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            {/* Validation message */}
            {selectedCategories.length === 0 && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('categoriesRequired')}
                </p>
            )}
        </div>
    );
});
