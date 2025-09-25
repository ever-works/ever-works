'use client';

import React, { useTransition, memo } from 'react';
import { ItemData } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { removeItem } from '@/app/actions/dashboard/items';
import { toast } from 'sonner';
import { Trash2, ExternalLink, MoreVertical, Loader2 } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ItemCardProps {
    item: ItemData;
    viewMode: 'grid' | 'list';
    directoryId: string;
    onDelete?: () => void;
}

export const ItemCard = memo(function ItemCard({
    item,
    viewMode,
    directoryId,
    onDelete,
}: ItemCardProps) {
    const t = useTranslations('dashboard.directoryDetail.items');
    const [isPending, startTransition] = useTransition();

    const handleDelete = () => {
        if (!confirm(t('deleteConfirm', { name: item.name }))) {
            return;
        }

        startTransition(async () => {
            try {
                const result = await removeItem(directoryId, item.slug!);
                if (result.success) {
                    toast.success(result.message || t('deleteSuccess'));
                    onDelete?.();
                } else {
                    toast.error(result.message || t('deleteFailed'));
                }
            } catch (error) {
                toast.error(t('deleteError'));
            }
        });
    };

    if (viewMode === 'list') {
        return <ItemCardList item={item} onDelete={handleDelete} isPending={isPending} />;
    }

    return <ItemCardGrid item={item} onDelete={handleDelete} isPending={isPending} />;
});

interface ItemCardViewProps {
    item: ItemData;
    onDelete: () => void;
    isPending: boolean;
}

const ItemCardList = memo(function ItemCardList({ item, onDelete, isPending }: ItemCardViewProps) {
    const t = useTranslations('dashboard.directoryDetail.items');

    return (
        <div
            className={cn(
                'flex items-center gap-4 p-4 rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
                'hover:border-primary/50 transition-colors',
            )}
        >
            <div className="flex-1">
                <h4 className="font-medium text-text dark:text-text-dark">{item.name}</h4>
                {item.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-1">
                        {item.description}
                    </p>
                )}
            </div>
            {item.category && (
                <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary">
                    {item.category}
                </span>
            )}

            <div className="flex items-center gap-2">
                {item.source_url && (
                    <Link
                        href={item.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs hover:underline flex items-center gap-1"
                    >
                        <ExternalLink className="w-3 h-3" />
                    </Link>
                )}
                <ItemActions onDelete={onDelete} isPending={isPending} />
            </div>
        </div>
    );
});

const ItemCardGrid = memo(function ItemCardGrid({ item, onDelete, isPending }: ItemCardViewProps) {
    const t = useTranslations('dashboard.directoryDetail.items');

    return (
        <div
            className={cn(
                'p-4 rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
                'hover:border-primary/50 transition-colors',
            )}
        >
            <div className="flex items-start justify-between mb-2">
                <h4 className="font-medium text-text dark:text-text-dark line-clamp-1">
                    {item.name}
                </h4>
                <ItemActions onDelete={onDelete} isPending={isPending} />
            </div>

            {item.description && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-3">
                    {item.description}
                </p>
            )}

            <div className="flex items-center justify-between">
                {item.category && (
                    <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary">
                        {item.category}
                    </span>
                )}
                {item.source_url && (
                    <Link
                        href={item.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                        <ExternalLink className="w-3 h-3" />
                        {t('source')}
                    </Link>
                )}
            </div>
        </div>
    );
});

interface ItemActionsProps {
    onDelete: () => void;
    isPending: boolean;
}

const ItemActions = memo(function ItemActions({ onDelete, isPending }: ItemActionsProps) {
    const t = useTranslations('dashboard.directoryDetail.items');

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" disabled={isPending}>
                    {isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <MoreVertical className="w-4 h-4" />
                    )}
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onDelete} className="text-danger dark:text-danger-dark">
                    <Trash2 className="w-4 h-4 mr-2" />
                    {t('delete')}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
});
