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
import { ItemsListSkeleton } from './ItemsListSkeleton';
import { AddItemModal } from './AddItemModal';
import { ItemsExportButton } from './ItemsExportButton';
import { ItemsImportButton } from './ItemsImportButton';
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
import { checkScreenshotAvailability, loadItemsForList } from '@/app/actions/dashboard/items';
import { ItemsProvider } from './ItemsContext';
import type { ProviderOption } from '@/lib/api/types-only';

type TabType = 'items' | 'categories' | 'tags' | 'collections' | 'sourceHealth';

interface ItemsPageClientProps {
    workId: string;
    sourceValidationSettings?: SourceValidationSettingsDto | null;
}

export function ItemsPageClient({ workId, sourceValidationSettings }: ItemsPageClientProps) {
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

    // Items + taxonomy are loaded lazily on mount so the page shell
    // (title, tabs, search input, sticky actions) paints instantly
    // while the API clones the data repo in the background. The
    // result is keyed by `workId` so switching Works while a fetch
    // is in flight still shows skeletons (instead of the previous
    // Work's items) until the new fetch resolves — without needing
    // a setState-in-effect reset.
    type LoadedItems = {
        workId: string;
        items: ItemData[];
        categories: Category[];
        tags: Tag[];
        collections: Collection[];
        error: string | null;
    };
    const [loaded, setLoaded] = useState<LoadedItems | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadItemsForList(workId)
            .then((result) => {
                if (cancelled) return;
                setLoaded({ workId, ...result, error: null });
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('Failed to load items:', err);
                setLoaded({
                    workId,
                    items: [],
                    categories: [],
                    tags: [],
                    collections: [],
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        return () => {
            cancelled = true;
        };
    }, [workId]);

    const isLoadingItems = loaded?.workId !== workId;
    const items: ItemData[] | null = isLoadingItems ? null : loaded!.items;
    const initialCategories: Category[] = isLoadingItems ? [] : loaded!.categories;
    const initialTags: Tag[] = isLoadingItems ? [] : loaded!.tags;
    const initialCollections: Collection[] = isLoadingItems ? [] : loaded!.collections;
    const itemsLoadError: string | null = isLoadingItems ? null : loaded!.error;

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
            (items ?? [])
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
                    {activeTab === 'items' && (
                        <div className="flex items-center gap-2">
                            <ItemsExportButton workId={workId} />
                            {permissions.canEdit && <ItemsImportButton workId={workId} />}
                            {permissions.canEdit && (
                                <Button
                                    variant="primary"
                                    onClick={() => setIsAddModalOpen(true)}
                                    className={cn(
                                        'inline-flex items-center gap-2 whitespace-nowrap',
                                        'text-sm',
                                    )}
                                >
                                    <Plus className="w-4 h-4" />
                                    {t('addItem')}
                                </Button>
                            )}
                        </div>
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
            {activeTab === 'items' && isLoadingItems && (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('loadingFromRepo')}
                        </p>
                    </div>
                    <ItemsListSkeleton />
                </div>
            )}
            {activeTab === 'items' &&
                !isLoadingItems &&
                !itemsLoadError &&
                (items!.length === 0 ? (
                    <ItemsEmptyState workId={workId} />
                ) : (
                    <ItemsList items={items!} addItemRef={addItemRef} />
                ))}

            {activeTab === 'items' && itemsLoadError && (
                <div className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
                    <p className="text-sm text-red-800 dark:text-red-200">{itemsLoadError}</p>
                </div>
            )}

            {/*
             * `key={loaded?.workId ?? 'pending'}` forces a remount of
             * each taxonomy tab when items finish loading. Without
             * this, `CategoriesTab` / `TagsTab` / `CollectionsTab`
             * each call `useState(initialX)` and snapshot the empty
             * array on first render — they would never observe the
             * real taxonomy when it arrives, leaving the tab stuck
             * blank until the user navigated away and back.
             */}
            {activeTab === 'categories' && (
                <CategoriesTab
                    key={loaded?.workId ?? 'pending'}
                    workId={workId}
                    initialCategories={initialCategories}
                    items={items ?? []}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'tags' && (
                <TagsTab
                    key={loaded?.workId ?? 'pending'}
                    workId={workId}
                    initialTags={initialTags}
                    items={items ?? []}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'collections' && (
                <CollectionsTab
                    key={loaded?.workId ?? 'pending'}
                    workId={workId}
                    initialCollections={initialCollections}
                    items={items ?? []}
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
