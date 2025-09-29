'use client';

import React, { useState, useTransition, useCallback, memo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { addItem } from '@/app/actions/dashboard/items';
import { Loader2, Plus } from 'lucide-react';
import { AddItemForm, ItemFormData } from './AddItemForm';

interface AddItemModalProps {
    directoryId: string;
    categories: string[];
    isOpen: boolean;
    onClose: () => void;
    onSuccess?: () => void;
}

export const AddItemModal = memo(function AddItemModal({
    directoryId,
    categories,
    isOpen,
    onClose,
    onSuccess,
}: AddItemModalProps) {
    const t = useTranslations('dashboard.directoryDetail.items.addModal');
    const [isPending, startTransition] = useTransition();
    const [updateWithPR, setUpdateWithPR] = useState(false);

    const [formData, setFormData] = useState<ItemFormData>({
        name: '',
        description: '',
        source_url: '',
        category: categories[0] || '',
        tags: [],
        featured: false,
        pay_and_publish_now: false,
        slug: '',
    });

    const handleSubmit = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();

            if (
                !formData.name ||
                !formData.description ||
                !formData.source_url ||
                !formData.category
            ) {
                toast.error(t('errors.requiredFields'));
                return;
            }

            startTransition(async () => {
                try {
                    const submitData = {
                        ...formData,
                        slug:
                            formData.slug ||
                            formData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                    };

                    const result = await addItem(directoryId, submitData);

                    if (result.status === 'success') {
                        toast.success(result.message || t('success'));
                        onSuccess?.();
                        onClose();

                        // Reset form
                        setFormData({
                            name: '',
                            description: '',
                            source_url: '',
                            category: categories[0] || '',
                            tags: [],
                            featured: false,
                            pay_and_publish_now: false,
                            slug: '',
                        });
                    } else {
                        toast.error(result.message || t('failed'));
                    }
                } catch (error) {
                    toast.error(t('error'));
                }
            });
        },
        [formData, directoryId, categories, onSuccess, onClose, t],
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
