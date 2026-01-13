'use client';

import { useState } from 'react';
import { ItemData } from '@/lib/api/types-only';
import { ItemsList } from './ItemsList';
import { AddItemModal } from './AddItemModal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { getCategoryName } from '@/lib/utils/items';
import { useDirectoryDetail, useDirectoryPermissions } from '../DirectoryDetailContext';

interface ItemsPageClientProps {
    items: ItemData[];
    directoryId: string;
}

export function ItemsPageClient({ items, directoryId }: ItemsPageClientProps) {
    const t = useTranslations('dashboard.directoryDetail.items');
    const router = useRouter();
    const permissions = useDirectoryPermissions();
    const { directory } = useDirectoryDetail();
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);

    // Get unique categories from existing items
    const categories = Array.from(
        new Set(
            items
                .map((item) => getCategoryName(item.category))
                .filter((category): category is string => Boolean(category)),
        ),
    );

    // If no categories exist, provide some defaults
    const finalCategories = categories.length > 0 ? categories : [];

    const handleAddSuccess = () => {
        // Refresh the page to show new item
        router.refresh();
    };

    return (
        <>
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
                    {permissions.canEdit && (
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

            <ItemsList
                items={items}
                directoryId={directoryId}
                canEdit={permissions.canEdit}
                directoryWebsite={directory.website}
            />

            {permissions.canEdit && (
                <AddItemModal
                    directoryId={directoryId}
                    categories={finalCategories}
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    onSuccess={handleAddSuccess}
                />
            )}
        </>
    );
}
