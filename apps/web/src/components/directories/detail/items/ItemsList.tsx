'use client';

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { ItemData } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { Grid as GridIcon, List as ListIcon } from 'lucide-react';
import { ItemCard } from './ItemCard';
import { getCategoryName } from '@/lib/utils/items';

interface ItemsListProps {
    items: ItemData[];
    directoryId: string;
}

export function ItemsList({ items: initialItems, directoryId }: ItemsListProps) {
    const t = useTranslations('dashboard.directoryDetail.items');
    const [items, setItems] = useState(() => sortItems(initialItems));
    const [searchQuery, setSearchQuery] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const listContainerRef = useRef<HTMLDivElement>(null);

    // Start with first 30 items loaded
    const INITIAL_LOAD = 30;
    const [visibleRange, setVisibleRange] = useState({ start: 0, end: INITIAL_LOAD });

    // Memoize categories to prevent recalculation
    const categories = useMemo(() => {
        const names = items
            .map((item) => getCategoryName(item.category))
            .filter((category): category is string => Boolean(category));
        return Array.from(new Set(names));
    }, [items]);

    // Memoize filtered items to prevent unnecessary recalculations
    const filteredItems = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return items.filter((item) => {
            const matchesSearch =
                query === '' ||
                item.name.toLowerCase().includes(query) ||
                item.description?.toLowerCase().includes(query);

            const matchesCategory =
                !selectedCategory || getCategoryName(item.category) === selectedCategory;

            return matchesSearch && matchesCategory;
        });
    }, [items, searchQuery, selectedCategory]);

    // Reset visible range when filters change
    useEffect(() => {
        setVisibleRange({ start: 0, end: INITIAL_LOAD });
    }, [searchQuery, selectedCategory, viewMode, INITIAL_LOAD]);

    // Memoized callback for item deletion
    const handleItemDelete = useCallback((itemSlug: string) => {
        setItems((prev) => prev.filter((i) => i.slug !== itemSlug));
    }, []);

    return (
        <div className="space-y-6">
            {/* Search and Filter Bar */}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                    <Input
                        type="text"
                        placeholder={t('searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        variant="form"
                        className="w-full"
                    />
                </div>

                <div className="flex gap-2">
                    <select
                        value={selectedCategory || ''}
                        onChange={(e) => setSelectedCategory(e.target.value || null)}
                        className={cn(
                            'px-3 py-2 rounded-lg border text-sm',
                            'bg-surface dark:bg-surface-dark',
                            'border-border dark:border-border-dark',
                            'text-text dark:text-text-dark',
                        )}
                    >
                        <option value="">{t('allCategories')}</option>
                        {categories.map((cat) => (
                            <option key={cat} value={cat}>
                                {UnSlug(cat)}
                            </option>
                        ))}
                    </select>

                    <div className="flex rounded-lg border border-border dark:border-border-dark">
                        <Button
                            variant={viewMode === 'grid' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('grid')}
                            className="rounded-r-none"
                        >
                            <GridIcon className="w-4 h-4" />
                        </Button>
                        <Button
                            variant={viewMode === 'list' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('list')}
                            className="rounded-l-none"
                        >
                            <ListIcon className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* Items Count */}
            <div className="flex items-center justify-between">
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('showing', { current: filteredItems.length, total: items.length })}
                </p>
            </div>

            {/* Items Display */}
            <div ref={listContainerRef}>
                {filteredItems.length === 0 ? (
                    <div className="text-center py-12">
                        <p className="text-text-secondary dark:text-text-secondary-dark">
                            {t('noMatch')}
                        </p>
                    </div>
                ) : filteredItems.length <= INITIAL_LOAD ? (
                    // For small filtered results, render all items without virtualization
                    <div
                        className={cn(
                            viewMode === 'grid'
                                ? 'grid sm:grid-cols-2 lg:grid-cols-3 gap-4'
                                : 'space-y-2',
                        )}
                    >
                        {filteredItems.map((item) => (
                            <MemoizedItemCard
                                key={item.slug}
                                item={item}
                                viewMode={viewMode}
                                directoryId={directoryId}
                                onDelete={() => handleItemDelete(item.slug!)}
                            />
                        ))}
                    </div>
                ) : (
                    // For large filtered results, use virtualization
                    <VirtualizedList
                        items={filteredItems}
                        viewMode={viewMode}
                        directoryId={directoryId}
                        onItemDelete={handleItemDelete}
                        visibleRange={visibleRange}
                        setVisibleRange={setVisibleRange}
                    />
                )}
            </div>
        </div>
    );
}

// Memoized ItemCard to prevent unnecessary re-renders
const MemoizedItemCard = React.memo(ItemCard);

// Virtualized list that uses parent scroll with incremental loading
interface VirtualizedListProps {
    items: ItemData[];
    viewMode: 'grid' | 'list';
    directoryId: string;
    onItemDelete: (itemSlug: string) => void;
    visibleRange: { start: number; end: number };
    setVisibleRange: (range: { start: number; end: number }) => void;
}

function VirtualizedList({
    items,
    viewMode,
    directoryId,
    onItemDelete,
    visibleRange,
    setVisibleRange,
}: VirtualizedListProps) {
    const t = useTranslations('dashboard.directoryDetail.items');
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const ITEMS_PER_PAGE = 30; // Items to load at a time

    useEffect(() => {
        // Use Intersection Observer to detect when to load more items
        const observer = new IntersectionObserver(
            (entries) => {
                const target = entries[0];
                if (target.isIntersecting && visibleRange.end < items.length) {
                    // Load more items when the trigger element is visible
                    setVisibleRange({
                        start: 0,
                        end: Math.min(items.length, visibleRange.end + ITEMS_PER_PAGE),
                    });
                }
            },
            {
                root: document.getElementById('main-content'),
                rootMargin: '100px',
                threshold: 0.1,
            },
        );

        if (loadMoreRef.current) {
            observer.observe(loadMoreRef.current);
        }

        return () => {
            if (loadMoreRef.current) {
                observer.unobserve(loadMoreRef.current);
            }
        };
    }, [items.length, visibleRange.end, setVisibleRange]);

    // Get visible items - always start from 0 for simplicity
    const visibleItems = useMemo(() => items.slice(0, visibleRange.end), [items, visibleRange.end]);

    return (
        <div>
            {/* Render visible items */}
            <div
                className={cn(
                    viewMode === 'grid' ? 'grid sm:grid-cols-2 lg:grid-cols-3 gap-4' : 'space-y-2',
                )}
            >
                {visibleItems.map((item) => (
                    <MemoizedItemCard
                        key={item.slug}
                        item={item}
                        viewMode={viewMode}
                        directoryId={directoryId}
                        onDelete={() => onItemDelete(item.slug!)}
                    />
                ))}
            </div>

            {/* Load more trigger */}
            {visibleRange.end < items.length && (
                <div ref={loadMoreRef} className="text-center py-8">
                    <div className="inline-flex items-center gap-2">
                        <div className="w-4 h-4 border-2 border-primary dark:border-primary-dark border-t-transparent rounded-full animate-spin" />
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('loadingMore', { current: visibleRange.end, total: items.length })}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

function UnSlug(name: string) {
    return name
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
        .trim();
}

function sortItems(items: ItemData[]): ItemData[] {
    return [...items].sort((a, b) => {
        const aFeatured = !!a.featured;
        const bFeatured = !!b.featured;

        if (aFeatured !== bFeatured) {
            return aFeatured ? -1 : 1;
        }

        const orderA = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
        const orderB = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
        if (orderA !== orderB) {
            return orderA - orderB;
        }

        return a.name.localeCompare(b.name);
    });
}
