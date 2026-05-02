'use client';

import { useState } from 'react';
import { Tag } from '@/lib/api/types-only';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

interface TagModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: Partial<Tag>) => Promise<boolean>;
    tag: Tag | null;
    existingNames: string[];
}

export function TagModal({ isOpen, onClose, onSave, tag, existingNames }: TagModalProps) {
    if (!isOpen) return null;

    return (
        <TagModalContent
            key={tag?.id ?? 'new'}
            onClose={onClose}
            onSave={onSave}
            tag={tag}
            existingNames={existingNames}
        />
    );
}

function TagModalContent({ onClose, onSave, tag, existingNames }: Omit<TagModalProps, 'isOpen'>) {
    const t = useTranslations('dashboard.workDetail.items.taxonomy.tags.modal');
    const [name, setName] = useState(() => tag?.name ?? '');
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isEditing = !!tag;

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

        const data: Partial<Tag> = {
            name: name.trim(),
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
                        className="p-1 cursor-pointer rounded-lg hover:bg-gray-100 dark:hover:bg-white/6 transition-colors"
                    >
                        <X
                            strokeWidth={1.3}
                            className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark"
                        />
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
                            htmlFor="tag-name"
                            className="block text-sm font-medium text-text dark:text-text-dark mb-1"
                        >
                            {t('name')} <span className="text-red-500">*</span>
                        </label>
                        <Input
                            id="tag-name"
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
                        <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('nameHelp')}
                        </p>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-end gap-3 pt-4">
                        <Button type="button" variant="ghost" onClick={onClose} className="text-sm">
                            {t('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            disabled={isSaving}
                            className="text-sm"
                        >
                            {isSaving ? t('saving') : isEditing ? t('save') : t('create')}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
