'use client';

import { useState, useRef, useCallback, useLayoutEffect, useEffect, useMemo } from 'react';
import {
    ItemData,
    Category,
    Collection,
    Tag,
    SourceValidationSettingsDto,
} from '@/lib/api/types-only';
import { ItemsList } from './ItemsList';
import { AddItemModal } from './AddItemModal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Plus, Package, FolderTree, Tags as TagsIcon, Bookmark, ShieldCheck } from 'lucide-react';
import { getCategoryName } from '@/lib/utils/items';
import { useWorkDetail, useWorkPermissions } from '../WorkDetailContext';
import { CategoriesTab } from './CategoriesTab';
import { TagsTab } from './TagsTab';
import { CollectionsTab } from './CollectionsTab';
import { SourceValidationSettingsCard } from './SourceValidationSettingsCard';
import { ItemsEmptyState } from './ItemsEmptyState';
import { checkScreenshotAvailability } from '@/app/actions/dashboard/items';
import { ItemsProvider } from './ItemsContext';
import type { ProviderOption } from '@/lib/api/types-only';

type TabType = 'items' | 'categories' | 'tags' | 'collections' | 'sourceHealth';

interface ItemsPageClientProps {
    items: ItemData[];
    workId: string;
    categories?: Category[];
    tags?: Tag[];
    collections?: Collection[];
    sourceValidationSettings?: SourceValidationSettingsDto | null;
}

export function ItemsPageClient({
    items,
    workId,
    categories: initialCategories = [],
    tags: initialTags = [],
    collections: initialCollections = [],
    sourceValidationSettings,
}: ItemsPageClientProps) {
    const t = useTranslations('dashboard.workDetail.items');
    const permissions = useWorkPermissions();
    const { work } = useWorkDetail();
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('items');
    const [screenshotAvailable, setScreenshotAvailable] = useState(false);
    const [screenshotProviders, setScreenshotProviders] = useState<ProviderOption[]>([]);
    const [activeScreenshotProvider, setActiveScreenshotProvider] = useState<ProviderOption | null>(
        null,
    );
    const navRef = useRef<HTMLDivElement>(null);
    const [pillStyle, setPillStyle] = useState<{ left: number; width: number } | null>(null);

    useLayoutEffect(() => {
        const nav = navRef.current;
        if (!nav) return;
        const activeBtn = nav.querySelector('[data-active="true"]') as HTMLElement | null;
        if (!activeBtn) return;
        setPillStyle({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth });
    }, [activeTab]);

    useEffect(() => {
        if (permissions.canEdit) {
            checkScreenshotAvailability(workId).then((result) => {
                setScreenshotAvailable(result.available);
                setScreenshotProviders(result.providers ?? []);
                setActiveScreenshotProvider(result.activeProvider ?? null);
            });
        }
    }, [workId, permissions.canEdit]);

    // Ref to imperatively add items to the list
    const addItemRef = useRef<((item: ItemData) => void) | null>(null);

    // Get unique categories from existing items for the Add Item modal
    const categoryNames = Array.from(
        new Set(
            items
                .map((item) => getCategoryName(item.category))
                .filter((category): category is string => Boolean(category)),
        ),
    );

    // If no categories exist, provide some defaults
    const finalCategories = categoryNames.length > 0 ? categoryNames : [];

    // Callback to add item to the list immediately
    const handleItemAdded = useCallback((newItem: ItemData) => {
        if (addItemRef.current) {
            addItemRef.current(newItem);
        }
    }, []);

    const itemsContext = useMemo(
        () => ({
            workId,
            canEdit: permissions.canEdit,
            workWebsite: work.website,
            screenshotAvailable,
            screenshotProviders,
            activeScreenshotProvider,
        }),
        [
            activeScreenshotProvider,
            workId,
            permissions.canEdit,
            work.website,
            screenshotAvailable,
            screenshotProviders,
        ],
    );

    const tabs = [
        { id: 'items' as const, label: t('tabs.browseItems'), icon: Package },
        { id: 'categories' as const, label: t('tabs.categories'), icon: FolderTree },
        { id: 'tags' as const, label: t('tabs.tags'), icon: TagsIcon },
        { id: 'collections' as const, label: t('tabs.collections'), icon: Bookmark },
        { id: 'sourceHealth' as const, label: t('tabs.sourceHealth'), icon: ShieldCheck },
    ];

    return (
        <ItemsProvider value={itemsContext}>
            <div className="mb-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-2xl font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h2>
                        <p className="text-text-secondary dark:text-text-secondary-dark mt-1">
                            {t('subtitle')}
                        </p>
                    </div>
                    {permissions.canEdit && activeTab === 'items' && (
                        <Button
                            variant="primary"
                            onClick={() => setIsAddModalOpen(true)}
                            className={cn('inline-flex items-center gap-2', 'text-sm')}
                        >
                            <Plus className="w-4 h-4" />
                            {t('addItem')}
                        </Button>
                    )}
                </div>
            </div>

            {/* Tabs Navigation */}
            <div className="inline-flex items-center gap-1 mb-4 rounded-lg border border-border dark:border-border-dark bg-muted/40 dark:bg-muted/10 p-1">
                <nav
                    ref={navRef}
                    className="relative flex gap-1"
                    aria-label={t('tabs.navigationLabel')}
                >
                    {/* Sliding pill background */}
                    {pillStyle && (
                        <div
                            className="absolute top-0 bottom-0 rounded-md bg-button-primary dark:bg-button-primary-dark shadow-sm pointer-events-none transition-all duration-200 ease-in-out"
                            style={{ left: pillStyle.left, width: pillStyle.width }}
                        />
                    )}
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                data-active={isActive}
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    'relative z-10 cursor-pointer flex flex-1 items-center justify-center text-xs gap-2 whitespace-nowrap rounded-md px-4 py-1.5 font-medium transition-colors duration-200',
                                    isActive
                                        ? 'text-white dark:text-button-primary-foreground-dark'
                                        : 'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                <Icon className="w-4 h-4" />
                                {tab.label}
                            </button>
                        );
                    })}
                </nav>
            </div>

            {/* Tab Content */}
            {activeTab === 'items' &&
                (items.length === 0 ? (
                    <ItemsEmptyState workId={workId} />
                ) : (
                    <ItemsList items={items} addItemRef={addItemRef} />
                ))}

            {activeTab === 'categories' && (
                <CategoriesTab
                    workId={workId}
                    initialCategories={initialCategories}
                    items={items}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'tags' && (
                <TagsTab
                    workId={workId}
                    initialTags={initialTags}
                    items={items}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'collections' && (
                <CollectionsTab
                    workId={workId}
                    initialCollections={initialCollections}
                    items={items}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'sourceHealth' && (
                <SourceValidationSettingsCard
                    workId={workId}
                    settings={
                        sourceValidationSettings ?? {
                            enabled: false,
                            cadence: null,
                            nextRunAt: null,
                            lastRunAt: null,
                            allowedCadences: [],
                        }
                    }
                />
            )}

            {permissions.canEdit && (
                <AddItemModal
                    workId={workId}
                    categories={finalCategories}
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    onItemAdded={handleItemAdded}
                />
            )}
        </ItemsProvider>
    );
}
