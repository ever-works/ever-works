'use client';

import { useState, useMemo } from 'react';
import { Collection, ItemData } from '@/lib/api/types-only';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Plus, Pencil, Trash2, Search, Bookmark } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { CollectionModal } from './CollectionModal';
import {
    createCollection,
    updateCollection,
    deleteCollection,
} from '@/app/actions/dashboard/taxonomy';
import { toast } from 'sonner';

interface CollectionsTabProps {
    directoryId: string;
    initialCollections: Collection[];
    items: ItemData[];
    canEdit: boolean;
}

export function CollectionsTab({
    directoryId,
    initialCollections,
    items,
    canEdit,
}: CollectionsTabProps) {
    const t = useTranslations('dashboard.directoryDetail.items.taxonomy');
    const router = useRouter();
    const [collections, setCollections] = useState<Collection[]>(initialCollections);
    const [searchQuery, setSearchQuery] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);

    // Count items per collection
    const itemCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        items.forEach((item) => {
            if (item.collection) {
                const normalized = item.collection.toLowerCase().trim();
                counts[normalized] = (counts[normalized] || 0) + 1;
            }
        });
        return counts;
    }, [items]);

    // Filter collections based on search
    const filteredCollections = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return collections.filter(
            (col) =>
                col.name.toLowerCase().includes(query) ||
                col.description?.toLowerCase().includes(query),
        );
    }, [collections, searchQuery]);

    const handleCreate = () => {
        setEditingCollection(null);
        setIsModalOpen(true);
    };

    const handleEdit = (collection: Collection) => {
        setEditingCollection(collection);
        setIsModalOpen(true);
    };

    const handleDelete = async (collection: Collection) => {
        const itemCount = itemCounts[collection.id.toLowerCase().trim()] || 0;
        if (itemCount > 0) {
            toast.error(t('collections.deleteHasItems', { count: itemCount }));
            return;
        }

        if (!confirm(t('collections.deleteConfirm', { name: collection.name }))) {
            return;
        }

        setIsDeleting(collection.id);
        try {
            const result = await deleteCollection(directoryId, collection.id);
            if (result.success) {
                setCollections((prev) => prev.filter((c) => c.id !== collection.id));
                toast.success(t('collections.deleteSuccess'));
                router.refresh();
            } else {
                toast.error(result.error || t('collections.deleteFailed'));
            }
        } catch (error) {
            toast.error(t('collections.deleteFailed'));
        } finally {
            setIsDeleting(null);
        }
    };

    const handleSave = async (data: Partial<Collection>) => {
        try {
            if (editingCollection) {
                const result = await updateCollection(directoryId, editingCollection.id, data);
                if (result.success && result.collection) {
                    setCollections((prev) =>
                        prev.map((c) => (c.id === editingCollection.id ? result.collection! : c)),
                    );
                    toast.success(t('collections.updateSuccess'));
                    router.refresh();
                    return true;
                } else {
                    toast.error(result.error || t('collections.updateFailed'));
                    return false;
                }
            } else {
                const result = await createCollection(directoryId, data);
                if (result.success && result.collection) {
                    setCollections((prev) => [...prev, result.collection!]);
                    toast.success(t('collections.createSuccess'));
                    router.refresh();
                    return true;
                } else {
                    toast.error(result.error || t('collections.createFailed'));
                    return false;
                }
            }
        } catch (error) {
            toast.error(
                editingCollection ? t('collections.updateFailed') : t('collections.createFailed'),
            );
            return false;
        }
    };

    return (
        <div className="space-y-6">
            {/* Header with search and add button */}
            <div className="flex flex-col @sm/main:flex-row gap-4 items-start @sm/main:items-center justify-between">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                    <Input
                        type="text"
                        placeholder={t('collections.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        variant="form"
                        className="pl-10"
                    />
                </div>
                {canEdit && (
                    <Button
                        variant="primary"
                        onClick={handleCreate}
                        className="inline-flex items-center gap-2 text-sm"
                    >
                        <Plus className="w-4 h-4" />
                        {t('collections.add')}
                    </Button>
                )}
            </div>

            {/* Collections count */}
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('collections.showing', {
                    current: filteredCollections.length,
                    total: collections.length,
                })}
            </p>

            {/* Collections list */}
            {filteredCollections.length === 0 ? (
                <div className="text-center py-12 rounded-xl border border-border dark:border-border-dark bg-muted/20 dark:bg-muted/5">
                    <Bookmark strokeWidth={0.6} className="w-12 h-12 mx-auto text-text-secondary dark:text-text-secondary-dark mb-4" />
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {collections.length === 0
                            ? t('collections.empty')
                            : t('collections.noMatch')}
                    </p>
                    {canEdit && collections.length === 0 && (
                        <Button variant="primary" onClick={handleCreate} className="mt-4 text-sm">
                            {t('collections.addFirst')}
                        </Button>
                    )}
                </div>
            ) : (
                <div className="rounded-xl border border-border dark:border-border-dark overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-muted/40 dark:bg-muted/10 border-b border-border dark:border-border-dark">
                                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
                                    {t('collections.columns.name')}
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark hidden @sm/main:table-cell">
                                    {t('collections.columns.description')}
                                </th>
                                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-24">
                                    {t('collections.columns.items')}
                                </th>
                                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-20">
                                    {t('collections.columns.priority')}
                                </th>
                                {canEdit && (
                                    <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-24">
                                        {t('collections.columns.actions')}
                                    </th>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border dark:divide-border-dark">
                            {filteredCollections.map((collection) => {
                                const count = itemCounts[collection.id.toLowerCase().trim()] || 0;
                                return (
                                    <tr
                                        key={collection.id}
                                        className="hover:bg-muted/20 dark:hover:bg-muted/10 transition-colors"
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-3">
                                                {collection.icon_url ? (
                                                    <img
                                                        src={collection.icon_url}
                                                        alt=""
                                                        className="w-6 h-6 rounded"
                                                    />
                                                ) : (
                                                    <Bookmark strokeWidth={1.3} className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0" />
                                                )}
                                                <span className="font-medium text-sm text-text dark:text-text-dark">
                                                    {collection.name}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 hidden @sm/main:table-cell">
                                            <span className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-1">
                                                {collection.description || '—'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <span
                                                className={cn(
                                                    'inline-flex items-center justify-center min-w-8 px-2 py-0.5 rounded-full text-xs font-medium ring-1',
                                                    count > 0
                                                        ? 'bg-primary/10 text-primary ring-primary/20'
                                                        : 'bg-muted/60 dark:bg-muted/20 text-text-muted dark:text-text-muted-dark ring-border dark:ring-border-dark',
                                                )}
                                            >
                                                {count}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <span className="text-sm tabular-nums text-text-secondary dark:text-text-secondary-dark">
                                                {collection.priority ?? '—'}
                                            </span>
                                        </td>
                                        {canEdit && (
                                            <td className="px-4 py-3">
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleEdit(collection)}
                                                        className="p-2"
                                                    >
                                                        <Pencil strokeWidth={1.3} className="w-4 h-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleDelete(collection)}
                                                        disabled={isDeleting === collection.id}
                                                        className="p-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20"
                                                    >
                                                        <Trash2 strokeWidth={1.3} className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Collection Modal */}
            <CollectionModal
                isOpen={isModalOpen}
                onClose={() => {
                    setIsModalOpen(false);
                    setEditingCollection(null);
                }}
                onSave={handleSave}
                collection={editingCollection}
                existingNames={collections
                    .filter((c) => c.id !== editingCollection?.id)
                    .map((c) => c.name.toLowerCase())}
            />
        </div>
    );
}
