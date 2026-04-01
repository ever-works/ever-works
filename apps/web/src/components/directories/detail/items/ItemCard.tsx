'use client';

import { memo } from 'react';
import { ItemData, ItemBadges } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { ExternalLink, Star, Eye, AlertTriangle } from 'lucide-react';
import { getCategoryName } from '@/lib/utils/items';
import { ItemActions } from './ItemActions';
import { useItemsContext } from './ItemsContext';

interface ItemCardProps {
    item: ItemData;
    viewMode: 'grid' | 'list';
    onDelete?: () => void;
    onUpdate?: (item: Partial<ItemData>) => void;
}

export const ItemCard = memo(function ItemCard({
    item,
    viewMode,
    onDelete,
    onUpdate,
}: ItemCardProps) {
    const { canEdit } = useItemsContext();

    if (viewMode === 'list') {
        return (
            <ItemCardList item={item} canEdit={canEdit} onDelete={onDelete} onUpdate={onUpdate} />
        );
    }

    return <ItemCardGrid item={item} canEdit={canEdit} onDelete={onDelete} onUpdate={onUpdate} />;
});

// ── List view ────────────────────────────────────────────────────

interface ItemCardViewProps {
    item: ItemData;
    canEdit: boolean;
    onDelete?: () => void;
    onUpdate?: (item: Partial<ItemData>) => void;
}

const ItemCardList = memo(function ItemCardList({
    item,
    canEdit,
    onDelete,
    onUpdate,
}: ItemCardViewProps) {
    const { directoryWebsite } = useItemsContext();
    const isFeatured = item.featured === true;
    const categoryName = getCategoryName(item.category);

    return (
        <div
            className={cn(
                'flex items-center gap-3 p-3 rounded-lg border',
                'bg-card dark:bg-card-primary-dark transition-colors',
                isFeatured
                    ? 'border-amber-400/50 dark:border-amber-500/30 bg-amber-50/30 dark:bg-amber-900/10'
                    : 'border-card-border dark:border-white/9 hover:border-primary-500/50 dark:hover:border-white/20',
            )}
        >
            {/* Main content — takes remaining space, truncates */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    {isFeatured && (
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                    )}
                    <span className="font-medium text-sm text-text dark:text-text-dark truncate">
                        {item.name}
                    </span>
                    <ItemHealthBadge item={item} />
                </div>
                {item.description && (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark truncate mt-0.5">
                        {item.description}
                    </p>
                )}
            </div>

            {/* Metadata — badges, order, category */}
            <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                <ItemBadgesDisplay badges={item.badges} />
                {item.order != null && (
                    <span className="px-1.5 py-0.5 text-[11px] font-medium rounded-full bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                        #{item.order}
                    </span>
                )}
                {categoryName && (
                    <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-primary/10 text-primary truncate max-w-[120px]">
                        {categoryName}
                    </span>
                )}
            </div>

            {/* Links + actions — fixed width area */}
            <div className="flex items-center gap-1 shrink-0">
                {directoryWebsite && item.slug && (
                    <Link
                        href={`${directoryWebsite}/details/${item.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 rounded text-text-secondary dark:text-text-secondary-dark hover:text-primary transition-colors"
                        aria-label="View on website"
                    >
                        <Eye className="w-3.5 h-3.5" />
                    </Link>
                )}
                {item.source_url && (
                    <Link
                        href={item.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 rounded text-text-secondary dark:text-text-secondary-dark hover:text-primary transition-colors"
                        aria-label="Open source URL"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                )}
                {canEdit && onDelete && (
                    <ItemActions
                        item={item}
                        onDelete={onDelete}
                        onUpdate={onUpdate}
                        isPending={false}
                    />
                )}
            </div>
        </div>
    );
});

// ── Grid view ────────────────────────────────────────────────────

const ItemCardGrid = memo(function ItemCardGrid({
    item,
    canEdit,
    onDelete,
    onUpdate,
}: ItemCardViewProps) {
    const { directoryWebsite } = useItemsContext();
    const t = useTranslations('dashboard.directoryDetail.items');
    const isFeatured = item.featured === true;
    const categoryName = getCategoryName(item.category);

    return (
        <div
            className={cn(
                'flex flex-col p-4 rounded-lg border',
                'bg-card dark:bg-card-primary-dark transition-colors',
                isFeatured
                    ? 'border-amber-400/30 dark:border-amber-500/30'
                    : 'border-card-border dark:border-white/9 hover:border-primary-500/50 dark:hover:border-white/20',
            )}
        >
            {/* Header: title + actions on same line */}
            <div className="flex items-start gap-2 mb-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {isFeatured && (
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                    )}
                    <h4 className="font-medium text-sm text-text dark:text-text-dark truncate">
                        {item.name}
                    </h4>
                    <ItemHealthBadge item={item} />
                </div>
                {canEdit && onDelete && (
                    <div className="shrink-0 -mt-1 -mr-1">
                        <ItemActions
                            item={item}
                            onDelete={onDelete}
                            onUpdate={onUpdate}
                            isPending={false}
                        />
                    </div>
                )}
            </div>

            {/* Badges */}
            <ItemBadgesDisplay badges={item.badges} className="mb-1.5" />

            {/* Description */}
            {item.description && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-3 flex-1">
                    {item.description}
                </p>
            )}

            {/* Footer: metadata + links */}
            <div className="flex items-center justify-between mt-auto pt-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    {item.order != null && (
                        <span className="px-1.5 py-0.5 text-[11px] font-medium rounded-full bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                            #{item.order}
                        </span>
                    )}
                    {categoryName && (
                        <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-primary/10 text-primary truncate max-w-[100px]">
                            {categoryName}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {directoryWebsite && item.slug && (
                        <Link
                            href={`${directoryWebsite}/items/${item.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-text-secondary dark:text-text-secondary-dark hover:text-primary transition-colors flex items-center gap-1"
                            aria-label="View on website"
                        >
                            <Eye className="w-3.5 h-3.5" />
                        </Link>
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
        </div>
    );
});

// ── Shared components ────────────────────────────────────────────

function ItemHealthBadge({ item }: { item: ItemData }) {
    const t = useTranslations('dashboard.directoryDetail.items.sourceValidation');

    if (!item.health || item.health.status === 'healthy' || item.health.status === 'unchecked') {
        return null;
    }

    const isBroken = item.health.status === 'broken';
    const label = isBroken ? t('brokenLink') : t('needsReview');

    return (
        <span
            className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0',
                isBroken
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
            )}
            title={item.health.message || label}
        >
            <AlertTriangle className="h-2.5 w-2.5" />
            {label}
        </span>
    );
}

const BADGE_STYLES: Record<string, { good: string; bad: string; neutral: string }> = {
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

function getBadgeVariant(_key: string, value: string): 'good' | 'bad' | 'neutral' {
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
                        className={cn(
                            'px-1.5 py-0.5 text-[11px] font-medium rounded',
                            styles[variant],
                        )}
                    >
                        {key}: {badge.value}
                    </span>
                );
            })}
        </div>
    );
});
