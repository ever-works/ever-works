'use client';

import { memo, useState } from 'react';
import {
    Combobox,
    ComboboxInput,
    ComboboxButton,
    ComboboxOptions,
    ComboboxOption,
} from '@headlessui/react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, X, Plus } from 'lucide-react';

interface CategoriesFieldProps {
    existingCategories: string[];
    selectedCategories: string[];
    onAddCategory: (category: string) => void;
    onRemoveCategory: (category: string) => void;
    isPending: boolean;
}

export const CategoriesField = memo(function CategoriesField({
    existingCategories,
    selectedCategories,
    onAddCategory,
    onRemoveCategory,
    isPending,
}: CategoriesFieldProps) {
    const t = useTranslations('dashboard.directoryDetail.items.addModal');
    const [query, setQuery] = useState('');

    // Filter categories based on search query
    const filteredCategories =
        query === ''
            ? existingCategories
            : existingCategories.filter((category) =>
                  category.toLowerCase().includes(query.toLowerCase()),
              );

    // Check if query matches an existing category (case-insensitive)
    const queryMatchesExisting = existingCategories.some(
        (cat) => cat.toLowerCase() === query.toLowerCase(),
    );

    // Check if query is already selected
    const queryAlreadySelected = selectedCategories.some(
        (cat) => cat.toLowerCase() === query.toLowerCase(),
    );

    // Show "Create new" option if query doesn't match existing and isn't selected
    const showCreateOption = query.trim() && !queryMatchesExisting && !queryAlreadySelected;

    const handleSelect = (value: string | null) => {
        if (!value) return;

        if (selectedCategories.includes(value)) {
            onRemoveCategory(value);
        } else {
            onAddCategory(value);
        }
        setQuery('');
    };

    const handleCreateNew = () => {
        if (query.trim() && !queryAlreadySelected) {
            onAddCategory(query.trim());
            setQuery('');
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && showCreateOption) {
            e.preventDefault();
            handleCreateNew();
        }
        // Allow backspace to remove last selected category when input is empty
        if (e.key === 'Backspace' && query === '' && selectedCategories.length > 0) {
            onRemoveCategory(selectedCategories[selectedCategories.length - 1]);
        }
    };

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-text dark:text-text-dark">
                {t('categories')} *
            </label>

            <Combobox value={null} onChange={handleSelect} disabled={isPending}>
                <div className="relative">
                    {/* Trigger container with selected chips */}
                    <div
                        className={cn(
                            'flex flex-wrap items-center gap-1.5 min-h-[42px] px-3 py-2',
                            'rounded-lg border border-border dark:border-border-dark',
                            'bg-surface dark:bg-surface-dark',
                            'focus-within:border-primary dark:focus-within:border-primary-dark',
                            'focus-within:ring-2 focus-within:ring-primary/20',
                            isPending && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        {/* Selected category chips */}
                        {selectedCategories.map((category) => (
                            <span
                                key={category}
                                className={cn(
                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs',
                                    'bg-primary/10 dark:bg-primary-dark/10',
                                    'text-primary dark:text-primary-dark',
                                )}
                            >
                                {category}
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRemoveCategory(category);
                                    }}
                                    className="hover:opacity-70 focus:outline-none"
                                    disabled={isPending}
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </span>
                        ))}

                        {/* Search input */}
                        <ComboboxInput
                            className={cn(
                                'flex-1 min-w-[120px] bg-transparent border-none outline-none',
                                'text-sm text-text dark:text-text-dark',
                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                            )}
                            placeholder={
                                selectedCategories.length === 0
                                    ? t('categoryPlaceholder')
                                    : t('addMoreCategories')
                            }
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />

                        {/* Dropdown trigger button */}
                        <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-3">
                            <ChevronDown className="h-4 w-4 text-text-muted" />
                        </ComboboxButton>
                    </div>

                    {/* Dropdown options */}
                    <ComboboxOptions
                        className={cn(
                            'absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg',
                            'bg-surface dark:bg-surface-dark',
                            'border border-border dark:border-border-dark',
                            'shadow-lg focus:outline-none',
                            'py-1',
                        )}
                    >
                        {/* Create new option */}
                        {showCreateOption && (
                            <ComboboxOption
                                value={query.trim()}
                                className={({ active }) =>
                                    cn(
                                        'relative cursor-pointer select-none py-2 pl-10 pr-4',
                                        'text-text dark:text-text-dark',
                                        active && 'bg-primary/10 dark:bg-primary-dark/10',
                                    )
                                }
                            >
                                <span className="flex items-center gap-2">
                                    <Plus className="h-4 w-4 text-primary dark:text-primary-dark" />
                                    <span>
                                        {t('createCategory')}{' '}
                                        <span className="font-medium">"{query.trim()}"</span>
                                    </span>
                                </span>
                            </ComboboxOption>
                        )}

                        {/* Existing categories */}
                        {filteredCategories.length === 0 && !showCreateOption ? (
                            <div className="py-2 px-4 text-sm text-text-muted dark:text-text-muted-dark">
                                {query ? t('noMatchingCategories') : t('noCategories')}
                            </div>
                        ) : (
                            filteredCategories.map((category) => {
                                const isSelected = selectedCategories.includes(category);
                                return (
                                    <ComboboxOption
                                        key={category}
                                        value={category}
                                        className={({ active }) =>
                                            cn(
                                                'relative cursor-pointer select-none py-2 pl-10 pr-4',
                                                'text-text dark:text-text-dark',
                                                active &&
                                                    'bg-surface-hover dark:bg-surface-hover-dark',
                                                isSelected && 'bg-primary/5 dark:bg-primary-dark/5',
                                            )
                                        }
                                    >
                                        <span
                                            className={cn(
                                                'block truncate',
                                                isSelected && 'font-medium',
                                            )}
                                        >
                                            {category}
                                        </span>
                                        {isSelected && (
                                            <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-primary dark:text-primary-dark">
                                                <Check className="h-4 w-4" />
                                            </span>
                                        )}
                                    </ComboboxOption>
                                );
                            })
                        )}
                    </ComboboxOptions>
                </div>
            </Combobox>

            {/* Validation message */}
            {selectedCategories.length === 0 && (
                <p className="text-xs text-danger">{t('categoriesRequired')}</p>
            )}
        </div>
    );
});
