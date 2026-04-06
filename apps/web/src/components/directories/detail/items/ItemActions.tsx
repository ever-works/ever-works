'use client';

import React, { useState, useTransition, memo, useEffect } from 'react';
import { ItemData } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    removeItem,
    updateItem,
    captureScreenshot,
    checkItemHealth,
} from '@/app/actions/dashboard/items';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
    Loader2,
    MoreVertical,
    Trash2,
    SlidersHorizontal,
    Camera,
    ShieldAlert,
    Link2,
} from 'lucide-react';
import { useItemsContext } from './ItemsContext';

type ItemActionsProps = {
    item: ItemData;
    onDelete?: () => void;
    onUpdate?: (item: Partial<ItemData>) => void;
};

export const ItemActions = memo(function ItemActions({
    item,
    onDelete,
    onUpdate,
}: ItemActionsProps) {
    const t = useTranslations('dashboard.directoryDetail.items');
    const { directoryId, screenshotAvailable } = useItemsContext();
    const [isDisplayDialogOpen, setIsDisplayDialogOpen] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
    const [isCheckingHealth, setIsCheckingHealth] = useState(false);
    const [isApplyingSuggestedSource, setIsApplyingSuggestedSource] = useState(false);
    const suggestedSourceUrl =
        item.source_validation?.suggested_source_url &&
        item.source_validation.suggested_source_url !== item.source_url
            ? item.source_validation.suggested_source_url
            : null;

    const handleCaptureScreenshot = async () => {
        if (!item.source_url) {
            toast.error(t('screenshot.noSourceUrl', { defaultValue: 'No source URL available' }));
            return;
        }

        setIsCapturingScreenshot(true);
        try {
            const result = await captureScreenshot(item.source_url);

            if (result.success && result.imageUrl) {
                // Update the item's images with the new screenshot
                const currentImages = item.images || [];
                if (!currentImages.includes(result.imageUrl)) {
                    onUpdate?.({
                        images: [result.imageUrl, ...currentImages],
                    });
                }
                toast.success(
                    result.message ||
                        t('screenshot.success', { defaultValue: 'Screenshot captured' }),
                );
            } else {
                toast.error(
                    result.error ||
                        t('screenshot.failed', { defaultValue: 'Failed to capture screenshot' }),
                );
            }
        } catch (error) {
            toast.error(t('screenshot.error', { defaultValue: 'Screenshot capture error' }));
        } finally {
            setIsCapturingScreenshot(false);
        }
    };

    const handleCheckHealth = async () => {
        if (!item.slug) {
            return;
        }

        setIsCheckingHealth(true);
        try {
            const result = await checkItemHealth(directoryId, item.slug);

            if (result.status === 'success' && result.item) {
                onUpdate?.(result.item);
                toast.success(result.message || t('sourceValidation.checkCompleted'));
            } else {
                toast.error(result.message || t('sourceValidation.checkFailed'));
            }
        } catch (error) {
            toast.error(t('sourceValidation.checkFailed'));
        } finally {
            setIsCheckingHealth(false);
        }
    };

    const handleUseSuggestedSource = async () => {
        if (!item.slug || !suggestedSourceUrl) {
            return;
        }

        setIsApplyingSuggestedSource(true);
        try {
            const result = await updateItem(directoryId, {
                item_slug: item.slug,
                source_url: suggestedSourceUrl,
            });

            if (result.status === 'success') {
                onUpdate?.({
                    source_url: suggestedSourceUrl,
                    health: { status: 'unchecked' },
                    source_validation: undefined,
                });
                toast.success(result.message || t('sourceValidation.suggestedSourceApplied'));
            } else {
                toast.error(result.message || t('sourceValidation.failedToUseSuggestedSource'));
            }
        } catch (error) {
            toast.error(t('sourceValidation.failedToUseSuggestedSource'));
        } finally {
            setIsApplyingSuggestedSource(false);
        }
    };

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                            isCapturingScreenshot || isCheckingHealth || isApplyingSuggestedSource
                        }
                    >
                        {isCapturingScreenshot || isCheckingHealth || isApplyingSuggestedSource ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <MoreVertical className="w-4 h-4" />
                        )}
                    </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                    align="end"
                    className="w-48 bg-card dark:bg-card-primary-dark/30 border border-border dark:border-border-dark shadow-lg rounded-lg p-1"
                >
                    <DropdownMenuItem
                        onClick={() => setIsDisplayDialogOpen(true)}
                        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary dark:hover:text-primary focus:bg-surface-secondary dark:focus:bg-surface-secondary-dark transition-colors"
                    >
                        <SlidersHorizontal className="w-4 h-4" />
                        {t('editDisplay', { defaultValue: 'Edit display' })}
                    </DropdownMenuItem>
                    {item.source_url && (
                        <DropdownMenuItem
                            onClick={handleCheckHealth}
                            disabled={isCheckingHealth}
                            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary dark:hover:text-primary focus:bg-surface-secondary dark:focus:bg-surface-secondary-dark transition-colors"
                        >
                            {isCheckingHealth ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <ShieldAlert className="w-4 h-4" />
                            )}
                            {t('sourceValidation.recheckSource')}
                        </DropdownMenuItem>
                    )}
                    {suggestedSourceUrl && (
                        <DropdownMenuItem
                            onClick={handleUseSuggestedSource}
                            disabled={isApplyingSuggestedSource}
                            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary dark:hover:text-primary focus:bg-surface-secondary dark:focus:bg-surface-secondary-dark transition-colors"
                        >
                            {isApplyingSuggestedSource ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Link2 className="w-4 h-4" />
                            )}
                            {t('sourceValidation.useSuggestedSource')}
                        </DropdownMenuItem>
                    )}
                    {item.source_url && screenshotAvailable && (
                        <DropdownMenuItem
                            onClick={handleCaptureScreenshot}
                            disabled={isCapturingScreenshot}
                            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary dark:hover:text-primary focus:bg-surface-secondary dark:focus:bg-surface-secondary-dark transition-colors"
                        >
                            {isCapturingScreenshot ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Camera className="w-4 h-4" />
                            )}
                            {t('captureScreenshot', { defaultValue: 'Capture screenshot' })}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                        onClick={() => setIsDeleteDialogOpen(true)}
                        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-danger dark:text-danger-dark hover:bg-danger/10 focus:bg-danger/10 transition-colors"
                    >
                        <Trash2 className="w-4 h-4" />
                        {t('delete')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <DisplayDialog
                open={isDisplayDialogOpen}
                onOpenChange={setIsDisplayDialogOpen}
                item={item}
                directoryId={directoryId}
                onUpdate={onUpdate}
            />

            <DeleteDialog
                open={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                item={item}
                directoryId={directoryId}
                onDeleted={onDelete}
            />
        </>
    );
});

type DisplayDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    item: ItemData;
    directoryId: string;
    onUpdate?: (item: Partial<ItemData>) => void;
};

const DisplayDialog = ({ open, onOpenChange, item, directoryId, onUpdate }: DisplayDialogProps) => {
    const t = useTranslations('dashboard.directoryDetail.items');
    const [featured, setFeatured] = useState<boolean>(!!item.featured);
    const [order, setOrder] = useState<string>(
        item.order === undefined || item.order === null ? '' : String(item.order),
    );
    const [createPr, setCreatePr] = useState<boolean>(false);
    const [isSubmitting, startTransition] = useTransition();

    const handleSubmit = () => {
        startTransition(async () => {
            try {
                const parsedOrder =
                    order === ''
                        ? undefined
                        : Number.isNaN(Number(order))
                          ? undefined
                          : Number(order);

                const result = await updateItem(directoryId, {
                    item_slug: item.slug!,
                    featured,
                    order: parsedOrder,
                    create_pull_request: createPr,
                });

                if (result.status === 'success') {
                    toast.success(result.message || t('updateSuccess'));
                    onUpdate?.({
                        featured,
                        order: parsedOrder,
                    });
                    onOpenChange(false);
                } else {
                    toast.error(result.message || t('updateFailed'));
                }
            } catch (error) {
                toast.error(t('updateError'));
            }
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {t('editDisplay', { defaultValue: 'Edit display' })}: {item.name}
                    </DialogTitle>
                    <DialogDescription>
                        {t('editDisplayDescription', {
                            defaultValue: 'Toggle featured status and set display order.',
                        })}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <ToggleRow
                        label={t('addModal.featured')}
                        description={t('addModal.featuredHelp')}
                        checked={featured}
                        onChange={setFeatured}
                    />

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text dark:text-text-dark">
                            {t('orderLabel', { defaultValue: 'Display order (optional)' })}
                        </label>
                        <Input
                            type="number"
                            min={0}
                            value={order}
                            onChange={(e) => setOrder(e.target.value)}
                            placeholder="0"
                        />
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('orderHelp', {
                                defaultValue:
                                    'Lower numbers appear first within featured/non-featured items.',
                            })}
                        </p>
                    </div>

                    <ToggleRow
                        label={t('createPRLabel', { defaultValue: 'Create Pull Request' })}
                        description={t('createPRHelp', {
                            defaultValue:
                                'If enabled, changes are proposed via PR instead of direct commit.',
                        })}
                        checked={createPr}
                        onChange={setCreatePr}
                    />
                </div>

                <DialogFooter>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={isSubmitting}
                    >
                        {t('addModal.cancel')}
                    </Button>
                    <Button onClick={handleSubmit} disabled={isSubmitting} loading={isSubmitting}>
                        {t('updateItem', { defaultValue: 'Update item' })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

type DeleteDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    item: ItemData;
    directoryId: string;
    onDeleted?: () => void;
};

const DeleteDialog = ({ open, onOpenChange, item, directoryId, onDeleted }: DeleteDialogProps) => {
    const t = useTranslations('dashboard.directoryDetail.items');
    const [reason, setReason] = useState('');
    const [createPr, setCreatePr] = useState(false);
    const [isDeleting, startTransition] = useTransition();

    const handleDelete = () => {
        startTransition(async () => {
            try {
                const result = await removeItem(directoryId, item.slug!, {
                    reason: reason || undefined,
                    create_pull_request: createPr,
                });

                if (result.status === 'success') {
                    toast.success(result.message || t('deleteSuccess'));
                    onDeleted?.();
                    onOpenChange(false);
                } else {
                    toast.error(result.message || t('deleteFailed'));
                }
            } catch (error) {
                toast.error(t('deleteError'));
            }
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {t('deleteDialogTitle', { defaultValue: 'Delete item' })}: {item.name}
                    </DialogTitle>
                    <DialogDescription>
                        {t('deleteDialogDescription', {
                            name: item.name,
                            defaultValue: `This will remove ${item.name} from the repository.`,
                        })}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <ToggleRow
                        label={t('createPRLabel', { defaultValue: 'Create Pull Request' })}
                        description={t('createPRHelp', {
                            defaultValue:
                                'If enabled, deletion will be submitted as a PR instead of direct commit.',
                        })}
                        checked={createPr}
                        onChange={setCreatePr}
                    />

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-text dark:text-text-dark">
                            {t('reasonLabel', { defaultValue: 'Reason (optional)' })}
                        </label>
                        <Input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder={t('reasonPlaceholder', {
                                defaultValue: 'Why are you removing this item?',
                            })}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={isDeleting}
                    >
                        {t('addModal.cancel')}
                    </Button>
                    <Button variant="danger" loading={isDeleting} onClick={handleDelete}>
                        {t('confirmDelete', { defaultValue: 'Delete item' })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

type ToggleRowProps = {
    label: string;
    description: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
};

const ToggleRow = ({ label, description, checked, onChange }: ToggleRowProps) => (
    <div className="flex items-center justify-between">
        <div>
            <p className="text-sm font-medium text-text dark:text-text-dark">{label}</p>
            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                {description}
            </p>
        </div>
        <Switch checked={checked} onChange={onChange} />
    </div>
);
