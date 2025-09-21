'use client';

import { useState } from 'react';
import { ItemData } from '@/lib/api';
import { cn } from '@/lib/utils/cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ItemsListProps {
    items: ItemData[];
    directoryId: string;
}

export function ItemsList({ items: initialItems, directoryId }: ItemsListProps) {
    const [items, setItems] = useState(initialItems);
    const [searchQuery, setSearchQuery] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    // Get unique categories
    const categories = Array.from(new Set(items.map(item => item.category).filter(Boolean)));

    // Filter items based on search and category
    const filteredItems = items.filter(item => {
        const matchesSearch = searchQuery === '' ||
            item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            item.description?.toLowerCase().includes(searchQuery.toLowerCase());

        const matchesCategory = !selectedCategory || item.category === selectedCategory;

        return matchesSearch && matchesCategory;
    });

    return (
        <div className="space-y-6">
            {/* Search and Filter Bar */}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                    <Input
                        type="text"
                        placeholder="Search items..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        variant="form"
                        className="w-full"
                        icon={
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        }
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
                        <option value="">All Categories</option>
                        {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                        ))}
                    </select>

                    <div className="flex rounded-lg border border-border dark:border-border-dark">
                        <Button
                            variant={viewMode === 'grid' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('grid')}
                            className="rounded-r-none"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                            </svg>
                        </Button>
                        <Button
                            variant={viewMode === 'list' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('list')}
                            className="rounded-l-none"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M4 6h16M4 12h16M4 18h16" />
                            </svg>
                        </Button>
                    </div>
                </div>
            </div>

            {/* Items Count */}
            <div className="flex items-center justify-between">
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    Showing {filteredItems.length} of {items.length} items
                </p>
            </div>

            {/* Items Display */}
            {filteredItems.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        No items match your search criteria
                    </p>
                </div>
            ) : (
                <div className={cn(
                    viewMode === 'grid'
                        ? 'grid sm:grid-cols-2 lg:grid-cols-3 gap-4'
                        : 'space-y-2'
                )}>
                    {filteredItems.map((item) => (
                        <ItemCard key={item.slug} item={item} viewMode={viewMode} />
                    ))}
                </div>
            )}
        </div>
    );
}

interface ItemCardProps {
    item: ItemData;
    viewMode: 'grid' | 'list';
}

function ItemCard({ item, viewMode }: ItemCardProps) {
    if (viewMode === 'list') {
        return (
            <div className={cn(
                'flex items-center gap-4 p-4 rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
                'hover:border-primary/50 transition-colors',
            )}>
                <div className="flex-1">
                    <h4 className="font-medium text-text dark:text-text-dark">
                        {item.name}
                    </h4>
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
                <Button variant="ghost" size="sm">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                </Button>
            </div>
        );
    }

    return (
        <div className={cn(
            'p-4 rounded-lg border',
            'bg-card dark:bg-card-dark',
            'border-card-border dark:border-card-border-dark',
            'hover:border-primary/50 transition-colors',
        )}>
            <div className="flex items-start justify-between mb-2">
                <h4 className="font-medium text-text dark:text-text-dark line-clamp-1">
                    {item.name}
                </h4>
                <Button variant="ghost" size="sm">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                </Button>
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
                    <a
                        href={item.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                        Source
                    </a>
                )}
            </div>
        </div>
    );
}