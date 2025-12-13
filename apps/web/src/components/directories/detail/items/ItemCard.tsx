'use client';

import { memo, useTransition } from 'react';
import { ItemData, ItemBadges } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { removeItem } from '@/app/actions/dashboard/items';
import { toast } from 'sonner';
import { getCategoryName } from '@/lib/utils/items';
import { ItemActions } from './ItemActions';

interface ItemCardProps {
    item: ItemData;
    viewMode: 'grid' | 'list';
    directoryId: string;
    onDelete?: () => void;
    onUpdate?: (item: Partial<ItemData>) => void;
}

export const ItemCard = memo(function ItemCard({
    item,
    viewMode,
    directoryId,
    onDelete,
    onUpdate,
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
                if (result.status === 'success') {
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
        return (
            <ItemCardList
                item={item}
                onDelete={handleDelete}
                directoryId={directoryId}
                onUpdate={onUpdate}
                isPending={isPending}
            />
        );
    }

    return (
        <ItemCardGrid
            item={item}
            onDelete={handleDelete}
            directoryId={directoryId}
            onUpdate={onUpdate}
            isPending={isPending}
        />
    );
});

interface ItemCardViewProps {
    item: ItemData;
    onDelete: () => void;
    isPending: boolean;
    onUpdate?: (item: Partial<ItemData>) => void;
    directoryId: string;
}

const ItemCardList = memo(function ItemCardList({
    item,
    onDelete,
    isPending,
    onUpdate,
    directoryId,
}: ItemCardViewProps) {
    return (
        <div
            className={cn(
                'flex items-center gap-4 p-4 rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
                'hover:border-primary/50 transition-colors',
            )}
        >
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <h4 className="font-medium text-text dark:text-text-dark truncate">
                        {item.name}
                    </h4>
                    <ItemBadgesDisplay badges={item.badges} />
                </div>
                {item.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-1">
                        {item.description}
                    </p>
                )}
            </div>
            {getCategoryName(item.category) && (
                <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary shrink-0">
                    {getCategoryName(item.category)}
                </span>
            )}

            <div className="flex items-center gap-2 shrink-0">
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
                <ItemActions
                    item={item}
                    directoryId={directoryId}
                    onDelete={onDelete}
                    onUpdate={onUpdate}
                    isPending={isPending}
                />
            </div>
        </div>
    );
});

const ItemCardGrid = memo(function ItemCardGrid({
    item,
    onDelete,
    isPending,
    onUpdate,
    directoryId,
}: ItemCardViewProps) {
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
                <ItemActions
                    item={item}
                    directoryId={directoryId}
                    onDelete={onDelete}
                    onUpdate={onUpdate}
                    isPending={isPending}
                />
            </div>

            <ItemBadgesDisplay badges={item.badges} className="mb-2" />

            {item.description && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-3">
                    {item.description}
                </p>
            )}

            <div className="flex items-center justify-between">
                {getCategoryName(item.category) && (
                    <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary">
                        {getCategoryName(item.category)}
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

const BADGE_STYLES: Record<string, { good: string; bad: string; neutral: string }> = {
    // SOFTWARE badges
    security: {
        good: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
        bad: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
        neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
    },
    license: {
        good: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
        bad: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
        neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
    },
    quality: {
        good: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
        bad: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
        neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
    },
    // ECOMMERCE / SERVICES / GENERAL badges
    verified: {
        good: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
        bad: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
        neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
    },
    price_range: {
        good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
        bad: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400',
        neutral: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    },
    availability: {
        good: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
        bad: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
        neutral: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    },
    booking: {
        good: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400',
        bad: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
        neutral: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-400',
    },
    default: {
        good: 'bg-primary/10 text-primary',
        bad: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
        neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
    },
};

function getBadgeVariant(key: string, value: string): 'good' | 'bad' | 'neutral' {
    const goodValues = ['A', 'yes', 'in_stock', 'instant', 'online', 'both', '$'];
    const badValues = ['F', 'no', 'out_of_stock', '$$$'];
    const neutralValues = ['limited', 'in_person', 'contact', '$$'];

    if (goodValues.includes(value)) return 'good';
    if (badValues.includes(value)) return 'bad';
    if (neutralValues.includes(value)) return 'neutral';
    return 'neutral';
}

interface ItemBadgesDisplayProps {
    badges?: ItemBadges;
    className?: string;
}

const ItemBadgesDisplay = memo(function ItemBadgesDisplay({
    badges,
    className,
}: ItemBadgesDisplayProps) {
    if (!badges || Object.keys(badges).length === 0) {
        return null;
    }

    return (
        <div className={cn('flex flex-wrap gap-1', className)}>
            {Object.entries(badges).map(([key, badge]) => {
                if (!badge?.value) return null;

                const variant = getBadgeVariant(key, badge.value);
                const styles = BADGE_STYLES[key] || BADGE_STYLES.default;

                return (
                    <span
                        key={key}
                        title={badge.details || undefined}
                        className={cn('px-1.5 py-0.5 text-xs font-medium rounded', styles[variant])}
                    >
                        {key}: {badge.value}
                    </span>
                );
            })}
        </div>
    );
});
