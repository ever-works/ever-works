'use client';

import React, { useState, useTransition, useCallback, memo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { addItem } from '@/app/actions/dashboard/items';
import { Loader2, Plus } from 'lucide-react';
import { AddItemForm, ItemFormData } from './AddItemForm';
import { ItemData } from '@/lib/api/types-only';
import { GenerationErrorTooltip } from './GenerationErrorTooltip';
import { resolveErrorCode, type GenerationErrorCode } from '@/lib/items/generation-error-codes';

interface AddItemModalProps {
    workId: string;
    categories: string[];
    isOpen: boolean;
    onClose: () => void;
    onItemAdded?: (item: ItemData) => void;
}

export const AddItemModal = memo(function AddItemModal({
    workId,
    categories,
    isOpen,
    onClose,
    onItemAdded,
}: AddItemModalProps) {
    const t = useTranslations('dashboard.workDetail.items.addModal');
    const [isPending, startTransition] = useTransition();
    const [updateWithPR, setUpdateWithPR] = useState(false);
    const [inlineError, setInlineError] = useState<{
        message: string;
        code: GenerationErrorCode;
    } | null>(null);

    const [formData, setFormData] = useState<ItemFormData>({
        name: '',
        description: '',
        source_url: '',
        categories: [],
        tags: [],
        featured: false,
        pay_and_publish_now: true,
        slug: '',
        brand: '',
        brand_logo_url: '',
        images: [],
        markdown: '',
    });

    const handleSubmit = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();

            if (
                !formData.name ||
                !formData.description ||
                !formData.source_url ||
                formData.categories.length === 0
            ) {
                toast.error(t('errors.requiredFields'));
                return;
            }

            setInlineError(null);

            startTransition(async () => {
                try {
                    const submitData = {
                        name: formData.name,
                        description: formData.description,
                        source_url: formData.source_url,
                        category: formData.categories[0] ?? '',
                        categories: formData.categories,
                        tags: formData.tags,
                        featured: formData.featured,
                        // If user wants to create PR, disable pay_and_publish_now to avoid auto-merge
                        pay_and_publish_now: updateWithPR ? false : formData.pay_and_publish_now,
                        slug:
                            formData.slug ||
                            formData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                        brand: formData.brand || undefined,
                        brand_logo_url: formData.brand_logo_url || undefined,
                        images: formData.images.length > 0 ? formData.images : undefined,
                        markdown: formData.markdown.trim() ? formData.markdown : undefined,
                        // Pass the create_pull_request flag to the backend
                        create_pull_request: updateWithPR,
                    };

                    const result = await addItem(workId, submitData);

                    if (result.status === 'success') {
                        toast.success(result.message || t('success'));
                        setInlineError(null);

                        // If we have the item data, add it to the list immediately
                        if (result.item && onItemAdded) {
                            onItemAdded(result.item);
                        }

                        onClose();

                        // Reset form
                        setFormData({
                            name: '',
                            description: '',
                            source_url: '',
                            categories: [],
                            tags: [],
                            featured: false,
                            pay_and_publish_now: true,
                            slug: '',
                            brand: '',
                            brand_logo_url: '',
                            images: [],
                            markdown: '',
                        });
                    } else {
                        const errorMessage = result.message || t('failed');
                        const code = resolveErrorCode(result.error_code, errorMessage);
                        setInlineError({ message: errorMessage, code });
                        toast.error(errorMessage);
                    }
                } catch (error) {
                    const errorMessage = t('error');
                    setInlineError({ message: errorMessage, code: 'GENERIC_ERROR' });
                    toast.error(errorMessage);
                }
            });
        },
        [formData, workId, onClose, onItemAdded, t, updateWithPR],
    );

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit}>
                    <AddItemForm
                        categories={categories}
                        formData={formData}
                        setFormData={setFormData}
                        updateWithPR={updateWithPR}
                        setUpdateWithPR={setUpdateWithPR}
                        isPending={isPending}
                    />

                    {/* Inline error with hover popup */}
                    {inlineError && (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2">
                            <p className="text-sm text-red-700 dark:text-red-300 leading-snug flex-1">
                                {inlineError.message}
                            </p>
                            <GenerationErrorTooltip
                                errorCode={inlineError.code}
                                workId={workId}
                            />
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-border dark:border-border-dark">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={onClose}
                            disabled={isPending}
                        >
                            {t('cancel')}
                        </Button>
                        <Button type="submit" variant="primary" disabled={isPending}>
                            {isPending ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                    {t('adding')}
                                </>
                            ) : (
                                <>
                                    <Plus className="w-4 h-4 mr-2" />
                                    {t('addItem')}
                                </>
                            )}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
});
