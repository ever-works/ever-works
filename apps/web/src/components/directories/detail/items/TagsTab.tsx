'use client';

import { useState, useMemo } from 'react';
import { Tag, ItemData } from '@/lib/api/types-only';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Plus, Pencil, Trash2, Search, Tags } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { TagModal } from './TagModal';
import { createTag, updateTag, deleteTag } from '@/app/actions/dashboard/taxonomy';
import { toast } from 'sonner';

interface TagsTabProps {
    directoryId: string;
    initialTags: Tag[];
    items: ItemData[];
    canEdit: boolean;
}

function getTagName(tag: string | Tag): string {
    return typeof tag === 'string' ? tag : tag.name;
}

export function TagsTab({ directoryId, initialTags, items, canEdit }: TagsTabProps) {
    const t = useTranslations('dashboard.directoryDetail.items.taxonomy');
    const router = useRouter();
    const [tags, setTags] = useState<Tag[]>(initialTags);
    const [searchQuery, setSearchQuery] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTag, setEditingTag] = useState<Tag | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);

    const itemCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        items.forEach((item) => {
            if (item.tags && Array.isArray(item.tags)) {
                item.tags.forEach((tag) => {
                    const tagSlug = getTagName(tag).toLowerCase().trim();
                    counts[tagSlug] = (counts[tagSlug] || 0) + 1;
                });
            }
        });
        return counts;
    }, [items]);

    // Filter tags based on search
    const filteredTags = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return tags.filter((tag) => tag.name.toLowerCase().includes(query));
    }, [tags, searchQuery]);

    const handleCreate = () => {
        setEditingTag(null);
        setIsModalOpen(true);
    };

    const handleEdit = (tag: Tag) => {
        setEditingTag(tag);
        setIsModalOpen(true);
    };

    const handleDelete = async (tag: Tag) => {
        const itemCount = itemCounts[tag.id.toLowerCase().trim()] || 0;
        if (itemCount > 0) {
            toast.error(t('tags.deleteHasItems', { count: itemCount }));
            return;
        }

        if (!confirm(t('tags.deleteConfirm', { name: tag.name }))) {
            return;
        }

        setIsDeleting(tag.id);
        try {
            const result = await deleteTag(directoryId, tag.id);
            if (result.success) {
                setTags((prev) => prev.filter((t) => t.id !== tag.id));
                toast.success(t('tags.deleteSuccess'));
                router.refresh();
            } else {
                toast.error(result.error || t('tags.deleteFailed'));
            }
        } catch (error) {
            toast.error(t('tags.deleteFailed'));
        } finally {
            setIsDeleting(null);
        }
    };

    const handleSave = async (data: Partial<Tag>) => {
        try {
            if (editingTag) {
                // Update existing tag
                const result = await updateTag(directoryId, editingTag.id, data);
                if (result.success && result.tag) {
                    setTags((prev) => prev.map((t) => (t.id === editingTag.id ? result.tag! : t)));
                    toast.success(t('tags.updateSuccess'));
                    router.refresh();
                    return true;
                } else {
                    toast.error(result.error || t('tags.updateFailed'));
                    return false;
                }
            } else {
                // Create new tag
                const result = await createTag(directoryId, data);
                if (result.success && result.tag) {
                    setTags((prev) => [...prev, result.tag!]);
                    toast.success(t('tags.createSuccess'));
                    router.refresh();
                    return true;
                } else {
                    toast.error(result.error || t('tags.createFailed'));
                    return false;
                }
            }
        } catch (error) {
            toast.error(editingTag ? t('tags.updateFailed') : t('tags.createFailed'));
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
                        placeholder={t('tags.searchPlaceholder')}
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
                        {t('tags.add')}
                    </Button>
                )}
            </div>

            {/* Tags count */}
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('tags.showing', {
                    current: filteredTags.length,
                    total: tags.length,
                })}
            </p>

            {/* Tags list */}
            {filteredTags.length === 0 ? (
                <div className="text-center py-12 rounded-xl border border-border dark:border-border-dark bg-muted/20 dark:bg-muted/5">
                    <Tags
                        strokeWidth={0.6}
                        className="w-12 h-12 mx-auto text-text-secondary dark:text-text-secondary-dark mb-4"
                    />
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {tags.length === 0 ? t('tags.empty') : t('tags.noMatch')}
                    </p>
                    {canEdit && tags.length === 0 && (
                        <Button variant="primary" onClick={handleCreate} className="mt-4 text-sm">
                            {t('tags.addFirst')}
                        </Button>
                    )}
                </div>
            ) : (
                <div className="rounded-xl border border-border dark:border-border-dark overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-muted/40 dark:bg-muted/10 border-b border-border dark:border-border-dark">
                                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
                                    {t('tags.columns.name')}
                                </th>
                                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-24">
                                    {t('tags.columns.items')}
                                </th>
                                {canEdit && (
                                    <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-24">
                                        {t('tags.columns.actions')}
                                    </th>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border dark:divide-border-dark">
                            {filteredTags.map((tag) => {
                                const count = itemCounts[tag.id.toLowerCase().trim()] || 0;
                                return (
                                    <tr
                                        key={tag.id}
                                        className="hover:bg-muted/20 dark:hover:bg-muted/10 transition-colors"
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-3">
                                                <span
                                                    className={cn(
                                                        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1',
                                                        'bg-muted/60 dark:bg-muted/20 ring-border dark:ring-border-dark',
                                                        'text-text-secondary dark:text-text-secondary-dark',
                                                    )}
                                                >
                                                    {tag.name}
                                                </span>
                                            </div>
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
                                        {canEdit && (
                                            <td className="px-4 py-3">
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleEdit(tag)}
                                                        className="p-2"
                                                    >
                                                        <Pencil
                                                            strokeWidth={1.3}
                                                            className="w-4 h-4"
                                                        />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleDelete(tag)}
                                                        disabled={isDeleting === tag.id}
                                                        className="p-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20"
                                                    >
                                                        <Trash2
                                                            strokeWidth={1.3}
                                                            className="w-4 h-4"
                                                        />
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

            {/* Tag Modal */}
            <TagModal
                isOpen={isModalOpen}
                onClose={() => {
                    setIsModalOpen(false);
                    setEditingTag(null);
                }}
                onSave={handleSave}
                tag={editingTag}
                existingNames={tags
                    .filter((t) => t.id !== editingTag?.id)
                    .map((t) => t.name.toLowerCase())}
            />
        </div>
    );
}
