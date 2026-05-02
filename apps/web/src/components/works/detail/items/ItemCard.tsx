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
    const { workWebsite } = useItemsContext();
    const t = useTranslations('dashboard.workDetail.items');
    const isFeatured = item.featured === true;
    const categoryName = getCategoryName(item.category);

    return (
        <div
            className={cn(
                'group flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-200',
                'shadow-sm',
                isFeatured
                    ? 'border-primary/25 bg-card dark:bg-card-primary-dark/60 dark:border-primary/20 shadow-sm shadow-primary/50 dark:shadow-none'
                    : 'border-card-border dark:border-border-dark hover:border-primary/30 dark:hover:border-border-secondary-dark hover:shadow-sm',
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
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark truncate mt-0.5 mr-10">
                        {item.description}
                    </p>
                )}
            </div>

            {/* Metadata — badges, order, category */}
            <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                <ItemBadgesDisplay badges={item.badges} />
                {item.order != null && (
                    <span className="px-1.5 py-0.5 text-[11px] font-medium rounded-full bg-muted/60 dark:bg-muted/20 text-text-muted dark:text-text-muted-dark ring-1 ring-border dark:ring-border-dark tabular-nums">
                        #{item.order}
                    </span>
                )}
                {categoryName && (
                    <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-primary/10 text-primary font-medium truncate max-w-[120px]">
                        {categoryName}
                    </span>
                )}
            </div>

            {/* Links + actions — fixed width area */}
            <div className="flex items-center gap-1 shrink-0">
                {workWebsite && item.slug && (
                    <Link
                        href={`${workWebsite}/details/${item.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:text-primary hover:bg-primary/10 transition-colors"
                        aria-label={t('viewOnWebsite')}
                    >
                        <Eye className="w-3.5 h-3.5" />
                    </Link>
                )}
                {item.source_url && (
                    <Link
                        href={item.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:text-primary hover:bg-primary/10 transition-colors"
                        aria-label={t('openSourceUrl')}
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                )}
                {canEdit && onDelete && (
                    <ItemActions item={item} onDelete={onDelete} onUpdate={onUpdate} />
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
    const { workWebsite } = useItemsContext();
    const t = useTranslations('dashboard.workDetail.items');
    const isFeatured = item.featured === true;
    const categoryName = getCategoryName(item.category);

    return (
        <div
            className={cn(
                'group flex flex-col p-5 rounded-xl border transition-all duration-200',
                'shadow-sm',
                isFeatured
                    ? 'border-primary/25 dark:border-primary/20 shadow-sm shadow-primary/50 bg-card dark:bg-card-primary-dark/60 dark:shadow-none'
                    : 'border-card-border dark:border-border-dark hover:border-primary/30 dark:hover:border-border-secondary-dark hover:shadow-md hover:shadow-black/5 dark:hover:shadow-none',
            )}
        >
            {/* Header: title + actions on same line */}
            <div className="flex items-start gap-2 mb-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {isFeatured && (
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
                    )}
                    <h4 className="font-semibold text-sm text-text dark:text-text-dark truncate leading-snug">
                        {item.name}
                    </h4>
                    <ItemHealthBadge item={item} />
                </div>
                {canEdit && onDelete && (
                    <div className="shrink-0 -mt-1 -mr-1">
                        <ItemActions item={item} onDelete={onDelete} onUpdate={onUpdate} />
                    </div>
                )}
            </div>

            {/* Badges */}
            <ItemBadgesDisplay badges={item.badges} className="mb-1.5" />

            {/* Description */}
            {item.description && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-3 flex-1 leading-relaxed">
                    {item.description}
                </p>
            )}

            {/* Footer: metadata + links */}
            <div className="flex items-center justify-between mt-auto pt-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    {item.order != null && (
                        <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-muted/60 dark:bg-muted/20 text-text-muted dark:text-text-muted-dark ring-1 ring-border dark:ring-border-dark">
                            #{item.order}
                        </span>
                    )}
                    {categoryName && (
                        <span className="px-2 py-0.5 text-[11px] rounded-full bg-primary/10 text-primary font-medium truncate max-w-[120px]">
                            {categoryName}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {workWebsite && item.slug && (
                        <Link
                            href={`${workWebsite}/items/${item.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:text-primary hover:bg-primary/10 transition-colors"
                            aria-label={t('viewOnWebsite')}
                        >
                            <Eye className="w-3.5 h-3.5" />
                        </Link>
                    )}
                    {item.source_url && (
                        <Link
                            href={item.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
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
    const t = useTranslations('dashboard.workDetail.items.sourceValidation');

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
