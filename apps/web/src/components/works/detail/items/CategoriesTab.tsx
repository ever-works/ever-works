'use client';

import { useMemo, useState } from 'react';
import { Category, ItemData } from '@/lib/api/types-only';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { FolderTree, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { getCategoryNames } from '@/lib/utils/items';
import { CategoryModal } from './CategoryModal';
import { createCategory, updateCategory, deleteCategory } from '@/app/actions/dashboard/taxonomy';
import { toast } from 'sonner';

/**
 * M-09: defense-in-depth render-time SVG hardening. The agent-side
 * `sanitizeSvg` already strips script/event-handler/foreignObject on writes,
 * but pre-seeded or imported categories (account import, restored backups,
 * older code paths) can land unsanitized SVG in the DB and bypass that
 * guarantee on read. Run a conservative regex pass here too — if anything
 * dangerous slips through, swap this client copy for `isomorphic-dompurify`
 * when adding it as a dep.
 */
const SVG_DANGEROUS_TAG_RE = /<\/?(?:script|iframe|object|embed|foreignObject|use\s+[^>]*xlink:href)[^>]*>/gi;
const SVG_DANGEROUS_ATTR_RE = /\s(?:on[a-z]+|xlink:href|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function sanitizeSvgClient(svg: string): string {
    if (typeof svg !== 'string') return '';
    // Trim XML processing instructions / DOCTYPE that don't belong inline.
    return svg
        .replace(/<\?xml[^>]*\?>/gi, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(SVG_DANGEROUS_TAG_RE, '')
        .replace(SVG_DANGEROUS_ATTR_RE, '');
}

/**
 * Render the category's icon. Resolution order:
 *   1. `icon_svg` — server-sanitized inline SVG. Rendered with
 *      dangerouslySetInnerHTML so `stroke="currentColor"` themes
 *      through the wrapping span's text color. Backend strips
 *      scripts/event handlers/foreignObject before persistence
 *      (see svg-sanitizer.ts in @ever-works/agent).
 *   2. `icon_url` — legacy external image URL.
 *   3. Default `<FolderTree>` Lucide glyph.
 */
function CategoryIcon({ category }: { category: Category }) {
    if (category.icon_svg) {
        return (
            <span
                aria-hidden="true"
                className="inline-flex w-6 h-6 items-center justify-center text-text-secondary dark:text-text-secondary-dark shrink-0 [&>svg]:w-full [&>svg]:h-full"
                dangerouslySetInnerHTML={{ __html: sanitizeSvgClient(category.icon_svg) }}
            />
        );
    }
    if (category.icon_url) {
        return <img src={category.icon_url} alt="" className="w-6 h-6 rounded" />;
    }
    return (
        <FolderTree
            strokeWidth={1.3}
            className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0"
        />
    );
}

interface CategoriesTabProps {
    workId: string;
    initialCategories: Category[];
    items: ItemData[];
    canEdit: boolean;
}

export function CategoriesTab({ workId, initialCategories, items, canEdit }: CategoriesTabProps) {
    const t = useTranslations('dashboard.workDetail.items.taxonomy');
    const router = useRouter();
    const [categories, setCategories] = useState<Category[]>(initialCategories);
    const [searchQuery, setSearchQuery] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingCategory, setEditingCategory] = useState<Category | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);

    // Count items per category (items store slugified category, match against category.id)
    const itemCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        items.forEach((item) => {
            const categorySlugs = getCategoryNames(item.category);
            categorySlugs.forEach((slug) => {
                const normalized = slug.toLowerCase().trim();
                counts[normalized] = (counts[normalized] || 0) + 1;
            });
        });
        return counts;
    }, [items]);

    // Filter categories based on search
    const filteredCategories = useMemo(() => {
        const query = searchQuery.toLowerCase();
        return categories.filter(
            (cat) =>
                cat.name.toLowerCase().includes(query) ||
                cat.description?.toLowerCase().includes(query),
        );
    }, [categories, searchQuery]);

    const handleCreate = () => {
        setEditingCategory(null);
        setIsModalOpen(true);
    };

    const handleEdit = (category: Category) => {
        setEditingCategory(category);
        setIsModalOpen(true);
    };

    const handleDelete = async (category: Category) => {
        const itemCount = itemCounts[category.id.toLowerCase().trim()] || 0;
        if (itemCount > 0) {
            toast.error(t('categories.deleteHasItems', { count: itemCount }));
            return;
        }

        if (!confirm(t('categories.deleteConfirm', { name: category.name }))) {
            return;
        }

        setIsDeleting(category.id);
        try {
            const result = await deleteCategory(workId, category.id);
            if (result.success) {
                setCategories((prev) => prev.filter((c) => c.id !== category.id));
                toast.success(t('categories.deleteSuccess'));
                router.refresh();
            } else {
                toast.error(result.error || t('categories.deleteFailed'));
            }
        } catch (error) {
            toast.error(t('categories.deleteFailed'));
        } finally {
            setIsDeleting(null);
        }
    };

    const handleSave = async (data: Partial<Category>) => {
        try {
            if (editingCategory) {
                // Update existing category
                const result = await updateCategory(workId, editingCategory.id, data);
                if (result.success && result.category) {
                    setCategories((prev) =>
                        prev.map((c) => (c.id === editingCategory.id ? result.category! : c)),
                    );
                    toast.success(t('categories.updateSuccess'));
                    router.refresh();
                    return true;
                } else {
                    toast.error(result.error || t('categories.updateFailed'));
                    return false;
                }
            } else {
                // Create new category
                const result = await createCategory(workId, data);
                if (result.success && result.category) {
                    setCategories((prev) => [...prev, result.category!]);
                    toast.success(t('categories.createSuccess'));
                    router.refresh();
                    return true;
                } else {
                    toast.error(result.error || t('categories.createFailed'));
                    return false;
                }
            }
        } catch (error) {
            toast.error(
                editingCategory ? t('categories.updateFailed') : t('categories.createFailed'),
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
                        placeholder={t('categories.searchPlaceholder')}
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
                        {t('categories.add')}
                    </Button>
                )}
            </div>

            {/* Categories count */}
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('categories.showing', {
                    current: filteredCategories.length,
                    total: categories.length,
                })}
            </p>

            {/* Categories list */}
            {filteredCategories.length === 0 ? (
                <div className="text-center py-12 rounded-xl border border-border dark:border-border-dark bg-muted/20 dark:bg-muted/5">
                    <FolderTree
                        strokeWidth={0.6}
                        className="w-12 h-12 mx-auto text-text-secondary dark:text-text-secondary-dark mb-4"
                    />
                    <p className="text-text-secondary dark:text-text-secondary-dark">
                        {categories.length === 0 ? t('categories.empty') : t('categories.noMatch')}
                    </p>
                    {canEdit && categories.length === 0 && (
                        <Button variant="primary" onClick={handleCreate} className="mt-4 text-sm">
                            {t('categories.addFirst')}
                        </Button>
                    )}
                </div>
            ) : (
                <div className="rounded-xl border border-border dark:border-border-dark overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-muted/40 dark:bg-muted/10 border-b border-border dark:border-border-dark">
                                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
                                    {t('categories.columns.name')}
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark hidden @sm/main:table-cell">
                                    {t('categories.columns.description')}
                                </th>
                                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-24">
                                    {t('categories.columns.items')}
                                </th>
                                <th className="text-center px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-20">
                                    {t('categories.columns.priority')}
                                </th>
                                {canEdit && (
                                    <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark w-24">
                                        {t('categories.columns.actions')}
                                    </th>
                                )}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border dark:divide-border-dark">
                            {filteredCategories.map((category) => {
                                const count = itemCounts[category.id.toLowerCase().trim()] || 0;
                                return (
                                    <tr
                                        key={category.id}
                                        className="hover:bg-muted/20 dark:hover:bg-muted/10 transition-colors"
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-3">
                                                <CategoryIcon category={category} />
                                                <span className="font-medium text-sm text-text dark:text-text-dark">
                                                    {category.name}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 hidden @sm/main:table-cell">
                                            <span className="text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-1">
                                                {category.description || '—'}
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
                                                {category.priority ?? '—'}
                                            </span>
                                        </td>
                                        {canEdit && (
                                            <td className="px-4 py-3">
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleEdit(category)}
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
                                                        onClick={() => handleDelete(category)}
                                                        disabled={isDeleting === category.id}
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

            {/* Category Modal */}
            <CategoryModal
                isOpen={isModalOpen}
                onClose={() => {
                    setIsModalOpen(false);
                    setEditingCategory(null);
                }}
                onSave={handleSave}
                category={editingCategory}
                existingNames={categories
                    .filter((c) => c.id !== editingCategory?.id)
                    .map((c) => c.name.toLowerCase())}
            />
        </div>
    );
}
