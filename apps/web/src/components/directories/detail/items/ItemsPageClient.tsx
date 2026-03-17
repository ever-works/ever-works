'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
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
import { useDirectoryDetail, useDirectoryPermissions } from '../DirectoryDetailContext';
import { CategoriesTab } from './CategoriesTab';
import { TagsTab } from './TagsTab';
import { CollectionsTab } from './CollectionsTab';
import { SourceValidationSettingsCard } from './SourceValidationSettingsCard';
import { ItemsEmptyState } from './ItemsEmptyState';
import { checkScreenshotAvailability } from '@/app/actions/dashboard/items';
import { ItemsProvider } from './ItemsContext';

type TabType = 'items' | 'categories' | 'tags' | 'collections' | 'sourceHealth';

interface ItemsPageClientProps {
    items: ItemData[];
    directoryId: string;
    categories?: Category[];
    tags?: Tag[];
    collections?: Collection[];
    sourceValidationSettings?: SourceValidationSettingsDto | null;
}

export function ItemsPageClient({
    items,
    directoryId,
    categories: initialCategories = [],
    tags: initialTags = [],
    collections: initialCollections = [],
    sourceValidationSettings,
}: ItemsPageClientProps) {
    const t = useTranslations('dashboard.directoryDetail.items');
    const permissions = useDirectoryPermissions();
    const { directory } = useDirectoryDetail();
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('items');
    const [screenshotAvailable, setScreenshotAvailable] = useState(false);

    useEffect(() => {
        if (permissions.canEdit) {
            checkScreenshotAvailability().then((result) => {
                setScreenshotAvailable(result.available);
            });
        }
    }, [permissions.canEdit]);

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
            directoryId,
            canEdit: permissions.canEdit,
            directoryWebsite: directory.website,
            screenshotAvailable,
        }),
        [directoryId, permissions.canEdit, directory.website, screenshotAvailable],
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
                            className={cn('inline-flex items-center gap-2')}
                        >
                            <Plus className="w-4 h-4" />
                            {t('addItem')}
                        </Button>
                    )}
                </div>
            </div>

            {/* Tabs Navigation */}
            <div className="mb-6 border-b border-border dark:border-border-dark">
                <nav className="-mb-px flex space-x-8" aria-label="Tabs">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    'flex items-center gap-2 whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium transition-colors',
                                    activeTab === tab.id
                                        ? 'border-primary text-primary dark:border-primary-dark dark:text-primary-dark'
                                        : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:border-border dark:hover:border-border-dark hover:text-text dark:hover:text-text-dark',
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
                    <ItemsEmptyState directoryId={directoryId} />
                ) : (
                    <ItemsList items={items} addItemRef={addItemRef} />
                ))}

            {activeTab === 'categories' && (
                <CategoriesTab
                    directoryId={directoryId}
                    initialCategories={initialCategories}
                    items={items}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'tags' && (
                <TagsTab
                    directoryId={directoryId}
                    initialTags={initialTags}
                    items={items}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'collections' && (
                <CollectionsTab
                    directoryId={directoryId}
                    initialCollections={initialCollections}
                    items={items}
                    canEdit={permissions.canEdit}
                />
            )}

            {activeTab === 'sourceHealth' && (
                <SourceValidationSettingsCard
                    directoryId={directoryId}
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
                    directoryId={directoryId}
                    categories={finalCategories}
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    onItemAdded={handleItemAdded}
                />
            )}
        </ItemsProvider>
    );
}
