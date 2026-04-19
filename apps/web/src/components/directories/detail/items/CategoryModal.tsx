'use client';

import { useState } from 'react';
import { Category } from '@/lib/api/types-only';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface CategoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: Partial<Category>) => Promise<boolean>;
    category: Category | null;
    existingNames: string[];
}

export function CategoryModal({
    isOpen,
    onClose,
    onSave,
    category,
    existingNames,
}: CategoryModalProps) {
    if (!isOpen) return null;

    return (
        <CategoryModalContent
            key={category?.id ?? 'new'}
            onClose={onClose}
            onSave={onSave}
            category={category}
            existingNames={existingNames}
        />
    );
}

function CategoryModalContent({
    onClose,
    onSave,
    category,
    existingNames,
}: Omit<CategoryModalProps, 'isOpen'>) {
    const t = useTranslations('dashboard.directoryDetail.items.taxonomy.categories.modal');
    const [name, setName] = useState(() => category?.name ?? '');
    const [description, setDescription] = useState(() => category?.description ?? '');
    const [iconUrl, setIconUrl] = useState(() => category?.icon_url ?? '');
    const [priority, setPriority] = useState(() => category?.priority?.toString() ?? '');
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isEditing = !!category;

    const validateName = (value: string): string | null => {
        if (!value.trim()) {
            return t('errors.nameRequired');
        }
        if (existingNames.includes(value.toLowerCase().trim())) {
            return t('errors.nameExists');
        }
        return null;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const nameError = validateName(name);
        if (nameError) {
            setError(nameError);
            return;
        }

        setIsSaving(true);
        setError(null);

        const data: Partial<Category> = {
            name: name.trim(),
            description: description.trim() || undefined,
            icon_url: iconUrl.trim() || undefined,
            priority: priority ? parseInt(priority, 10) : undefined,
        };

        const success = await onSave(data);
        setIsSaving(false);

        if (success) {
            onClose();
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

            {/* Modal */}
            <div className="relative bg-surface dark:bg-surface-dark rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border dark:border-border-dark">
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                        {isEditing ? t('editTitle') : t('createTitle')}
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                        <X className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {error && (
                        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    <div>
                        <label
                            htmlFor="category-name"
                            className="block text-sm font-medium text-text dark:text-text-dark mb-1"
                        >
                            {t('name')} <span className="text-red-500">*</span>
                        </label>
                        <Input
                            id="category-name"
                            type="text"
                            value={name}
                            onChange={(e) => {
                                setName(e.target.value);
                                setError(null);
                            }}
                            placeholder={t('namePlaceholder')}
                            variant="form"
                            required
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="category-description"
                            className="block text-sm font-medium text-text dark:text-text-dark mb-1"
                        >
                            {t('description')}
                        </label>
                        <textarea
                            id="category-description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('descriptionPlaceholder')}
                            rows={3}
                            className={cn(
                                'w-full px-3 py-2 rounded-lg border text-sm',
                                'bg-surface dark:bg-surface-dark',
                                'border-border dark:border-border-dark',
                                'text-text dark:text-text-dark',
                                'placeholder:text-text-secondary dark:placeholder:text-text-secondary-dark',
                                'focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-primary-dark',
                            )}
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="category-icon"
                            className="block text-sm font-medium text-text dark:text-text-dark mb-1"
                        >
                            {t('iconUrl')}
                        </label>
                        <Input
                            id="category-icon"
                            type="url"
                            value={iconUrl}
                            onChange={(e) => setIconUrl(e.target.value)}
                            placeholder={t('iconUrlPlaceholder')}
                            variant="form"
                        />
                        <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('iconUrlHelp')}
                        </p>
                    </div>

                    <div>
                        <label
                            htmlFor="category-priority"
                            className="block text-sm font-medium text-text dark:text-text-dark mb-1"
                        >
                            {t('priority')}
                        </label>
                        <Input
                            id="category-priority"
                            type="number"
                            value={priority}
                            onChange={(e) => setPriority(e.target.value)}
                            placeholder={t('priorityPlaceholder')}
                            variant="form"
                            min={0}
                        />
                        <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('priorityHelp')}
                        </p>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-end gap-3 pt-4">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t('cancel')}
                        </Button>
                        <Button type="submit" variant="primary" disabled={isSaving}>
                            {isSaving ? t('saving') : isEditing ? t('save') : t('create')}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
