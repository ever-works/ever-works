'use client';

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ItemData } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { Grid as GridIcon, List as ListIcon } from 'lucide-react';
import { ItemCard } from './ItemCard';
import { getCategoryName, getCategoryNames } from '@/lib/utils/items';

interface ItemsListProps {
    items: ItemData[];
    /** Ref to imperatively add a new item to the list */
    addItemRef?: React.RefObject<((item: ItemData) => void) | null>;
}

// Estimated heights for virtualization
const GRID_ROW_HEIGHT = 200; // Approximate height for grid cards
const LIST_ITEM_HEIGHT = 80; // Approximate height for list items
const GAP = 16; // Gap between items (gap-4 = 16px)

// Hook to get responsive column count based on main content container width
function useColumnCount(viewMode: 'grid' | 'list') {
    const [columns, setColumns] = useState(3);

    useEffect(() => {
        if (viewMode === 'list') return;

        const container = document.getElementById('main-content');
        if (!container) return;

        const updateColumns = () => {
            const width = container.clientWidth;
            if (width >= 768) {
                setColumns(3);
            } else if (width >= 480) {
                setColumns(2);
            } else {
                setColumns(1);
            }
        };

        const observer = new ResizeObserver(updateColumns);
        observer.observe(container);
        updateColumns();

        return () => observer.disconnect();
    }, [viewMode]);

    return viewMode === 'list' ? 1 : columns;
}

export function ItemsList({ items: initialItems, addItemRef }: ItemsListProps) {
    const t = useTranslations('dashboard.workDetail.items');
    const [items, setItems] = useState(() => sortItems(initialItems));
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const columns = useColumnCount(viewMode);

    // Read ?q= from URL for AI-driven search
    const initialQuery =
        typeof window !== 'undefined'
            ? (new URLSearchParams(window.location.search).get('q') ?? '')
            : '';
    const [searchQuery, setSearchQuery] = useState(initialQuery);

    useEffect(() => {
        scrollContainerRef.current = document.getElementById('main-content');
    }, []);

    // Handle ?q= param on mount
    useEffect(() => {
        if (initialQuery) {
            searchInputRef.current?.focus();
            const url = new URL(window.location.href);
            url.searchParams.delete('q');
            window.history.replaceState({}, '', url.toString());
        }
    }, [initialQuery]);

    // Expose addItem function via ref for parent components
    const handleAddItem = useCallback((newItem: ItemData) => {
        setItems((prev) => {
            // Check for duplicates by slug
            if (newItem.slug && prev.some((item) => item.slug === newItem.slug)) {
                return prev;
            }
            return sortItems([newItem, ...prev]);
        });
    }, []);

    // Assign the addItem handler to the ref
    useEffect(() => {
        if (addItemRef?.current) {
            addItemRef.current = handleAddItem;
        }
    }, [addItemRef, handleAddItem]);

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
                !selectedCategory || getCategoryNames(item.category).includes(selectedCategory);

            return matchesSearch && matchesCategory;
        });
    }, [items, searchQuery, selectedCategory]);

    // Memoized callback for item deletion
    const handleItemDelete = useCallback((itemSlug: string) => {
        setItems((prev) => prev.filter((i) => i.slug !== itemSlug));
    }, []);

    const handleItemUpdate = useCallback((updated: Partial<ItemData> & { slug?: string }) => {
        if (!updated.slug) return;
        setItems((prev) =>
            sortItems(
                prev.map((item) => (item.slug === updated.slug ? { ...item, ...updated } : item)),
            ),
        );
    }, []);

    return (
        <div className="space-y-6">
            {/* Search and Filter Bar */}
            <div className="flex flex-col @sm/main:flex-row @sm/main:items-center gap-4">
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

                <div className="flex gap-2 items-center border p-[3px] rounded-xl">
                    <Select
                        value={selectedCategory || '__all__'}
                        onValueChange={(val) => setSelectedCategory(val === '__all__' ? null : val)}
                        size="sm"
                        className="w-auto min-w-36"
                    >
                        <option value="__all__">{t('allCategories')}</option>
                        {categories.map((cat) => (
                            <option key={cat} value={cat}>
                                {UnSlug(cat)}
                            </option>
                        ))}
                    </Select>

                    <div className="flex items-center rounded-lg border border-border dark:border-border-dark">
                        <Button
                            variant={viewMode === 'grid' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('grid')}
                            className="rounded-r-none"
                        >
                            <GridIcon className="w-3 h-3" />
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
            {filteredItems.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {t('noMatch')}
                    </p>
                </div>
            ) : (
                <VirtualizedItemsList
                    items={filteredItems}
                    viewMode={viewMode}
                    columns={columns}
                    onItemDelete={handleItemDelete}
                    onItemUpdate={handleItemUpdate}
                    scrollContainerRef={scrollContainerRef}
                />
            )}
        </div>
    );
}

// Memoized ItemCard to prevent unnecessary re-renders
const MemoizedItemCard = React.memo(ItemCard);

interface VirtualizedItemsListProps {
    items: ItemData[];
    viewMode: 'grid' | 'list';
    columns: number;
    onItemDelete: (itemSlug: string) => void;
    onItemUpdate: (item: Partial<ItemData> & { slug?: string }) => void;
    scrollContainerRef: React.RefObject<HTMLElement | null>;
}

function VirtualizedItemsList({
    items,
    viewMode,
    columns,
    onItemDelete,
    onItemUpdate,
    scrollContainerRef,
}: VirtualizedItemsListProps) {
    const listRef = useRef<HTMLDivElement>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    // Calculate scroll margin (offset from top of scroll container to this component)
    useEffect(() => {
        const calculateScrollMargin = () => {
            if (listRef.current && scrollContainerRef.current) {
                const listRect = listRef.current.getBoundingClientRect();
                const containerRect = scrollContainerRef.current.getBoundingClientRect();
                setScrollMargin(
                    listRect.top - containerRect.top + scrollContainerRef.current.scrollTop,
                );
            }
        };

        calculateScrollMargin();
        // Recalculate on resize
        window.addEventListener('resize', calculateScrollMargin);
        return () => window.removeEventListener('resize', calculateScrollMargin);
    }, [scrollContainerRef]);

    // Calculate rows for grid view
    const rows = useMemo(() => {
        if (viewMode === 'list') {
            return items.map((item) => [item]);
        }
        // Group items into rows based on column count
        const result: ItemData[][] = [];
        for (let i = 0; i < items.length; i += columns) {
            result.push(items.slice(i, i + columns));
        }
        return result;
    }, [items, columns, viewMode]);

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollContainerRef.current,
        estimateSize: () => (viewMode === 'list' ? LIST_ITEM_HEIGHT + GAP : GRID_ROW_HEIGHT + GAP),
        overscan: 5, // Render 5 extra rows above/below viewport
        scrollMargin,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();
    const totalSize = rowVirtualizer.getTotalSize();

    return (
        <div ref={listRef} className="relative w-full" style={{ height: `${totalSize}px` }}>
            {virtualRows.map((virtualRow) => {
                const rowItems = rows[virtualRow.index];
                return (
                    <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        className={cn(
                            'absolute top-0 left-0 w-full',
                            viewMode === 'grid'
                                ? 'grid @sm/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4'
                                : '',
                        )}
                        style={{
                            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                        }}
                    >
                        {rowItems.map((item) => (
                            <MemoizedItemCard
                                key={item.slug}
                                item={item}
                                viewMode={viewMode}
                                onDelete={() => onItemDelete(item.slug!)}
                                onUpdate={(updated) =>
                                    onItemUpdate({ ...updated, slug: item.slug })
                                }
                            />
                        ))}
                    </div>
                );
            })}
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
