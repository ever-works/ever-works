'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface CategoriesFieldsProps {
    initialCategories: string[];
    priorityCategories: string[];
    targetKeywords: string[];
    onChange: (updates: {
        initial_categories?: string[];
        priority_categories?: string[];
        target_keywords?: string[];
    }) => void;
}

export function CategoriesFields({
    initialCategories,
    priorityCategories,
    targetKeywords,
    onChange,
}: CategoriesFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [newCategory, setNewCategory] = useState('');
    const [newPriority, setNewPriority] = useState('');
    const [newKeyword, setNewKeyword] = useState('');

    const addItem = (type: 'initial' | 'priority' | 'keyword', value: string) => {
        if (!value.trim()) return;

        if (type === 'initial') {
            onChange({ initial_categories: [...initialCategories, value] });
            setNewCategory('');
        } else if (type === 'priority') {
            onChange({ priority_categories: [...priorityCategories, value] });
            setNewPriority('');
        } else {
            onChange({ target_keywords: [...targetKeywords, value] });
            setNewKeyword('');
        }
    };

    const removeItem = (type: 'initial' | 'priority' | 'keyword', index: number) => {
        if (type === 'initial') {
            onChange({ initial_categories: initialCategories.filter((_, i) => i !== index) });
        } else if (type === 'priority') {
            onChange({ priority_categories: priorityCategories.filter((_, i) => i !== index) });
        } else {
            onChange({ target_keywords: targetKeywords.filter((_, i) => i !== index) });
        }
    };

    return (
        <div className="space-y-6">
            {/* Initial Categories */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                    {t('initialCategories')}
                </label>
                <div className="flex gap-2 mb-2">
                    <Input
                        type="text"
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value)}
                        onKeyPress={(e) =>
                            e.key === 'Enter' &&
                            (e.preventDefault(), addItem('initial', newCategory))
                        }
                        placeholder={t('addCategoryPlaceholder')}
                        variant="form"
                    />
                    <Button
                        type="button"
                        onClick={() => addItem('initial', newCategory)}
                        variant="secondary"
                        size="sm"
                    >
                        {t('add')}
                    </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                    {initialCategories.map((cat, index) => (
                        <span
                            key={index}
                            className={cn(
                                'inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm',
                                'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
                            )}
                        >
                            {cat}
                            <button
                                type="button"
                                onClick={() => removeItem('initial', index)}
                                className="ml-1 hover:text-blue-600 dark:hover:text-blue-400"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            </div>

            {/* Priority Categories */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                    {t('priorityCategories')}
                </label>
                <div className="flex gap-2 mb-2">
                    <Input
                        type="text"
                        value={newPriority}
                        onChange={(e) => setNewPriority(e.target.value)}
                        onKeyPress={(e) =>
                            e.key === 'Enter' &&
                            (e.preventDefault(), addItem('priority', newPriority))
                        }
                        placeholder={t('addPriorityCategoryPlaceholder')}
                        variant="form"
                    />
                    <Button
                        type="button"
                        onClick={() => addItem('priority', newPriority)}
                        variant="secondary"
                        size="sm"
                    >
                        {t('add')}
                    </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                    {priorityCategories.map((cat, index) => (
                        <span
                            key={index}
                            className={cn(
                                'inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm',
                                'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
                            )}
                        >
                            {cat}
                            <button
                                type="button"
                                onClick={() => removeItem('priority', index)}
                                className="ml-1 hover:text-purple-600 dark:hover:text-purple-400"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            </div>

            {/* Target Keywords */}
            <div>
                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                    {t('targetKeywords')}
                </label>
                <div className="flex gap-2 mb-2">
                    <Input
                        type="text"
                        value={newKeyword}
                        onChange={(e) => setNewKeyword(e.target.value)}
                        onKeyPress={(e) =>
                            e.key === 'Enter' &&
                            (e.preventDefault(), addItem('keyword', newKeyword))
                        }
                        placeholder={t('addKeywordPlaceholder')}
                        variant="form"
                    />
                    <Button
                        type="button"
                        onClick={() => addItem('keyword', newKeyword)}
                        variant="secondary"
                        size="sm"
                    >
                        {t('add')}
                    </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                    {targetKeywords.map((keyword, index) => (
                        <span
                            key={index}
                            className={cn(
                                'inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm',
                                'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
                            )}
                        >
                            {keyword}
                            <button
                                type="button"
                                onClick={() => removeItem('keyword', index)}
                                className="ml-1 hover:text-green-600 dark:hover:text-green-400"
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}
