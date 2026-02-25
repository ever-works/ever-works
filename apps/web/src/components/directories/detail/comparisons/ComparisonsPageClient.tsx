'use client';

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronLeft, ChevronRight, Grid, List, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { ComparisonData } from '@/lib/api/directory';
import { ROUTES } from '@/lib/constants';
import {
    generateNextComparison,
    generateManualComparison,
    deleteComparison,
    getRemainingComparisonCount,
} from '@/app/actions/dashboard/comparisons';

interface ComparisonsPageClientProps {
    directoryId: string;
    initialComparisons: ComparisonData[];
    items: Array<{ slug: string; name: string; category: string | string[] }>;
}

export function ComparisonsPageClient({
    directoryId,
    initialComparisons,
    items,
}: ComparisonsPageClientProps) {
    const [comparisons, setComparisons] = useState<ComparisonData[]>(initialComparisons);
    const [isPending, startTransition] = useTransition();
    const [selectedItemA, setSelectedItemA] = useState('');
    const [selectedItemB, setSelectedItemB] = useState('');
    const [showManualForm, setShowManualForm] = useState(false);
    const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
    const [currentPage, setCurrentPage] = useState(1);

    // Generate All state
    const [isGeneratingAll, setIsGeneratingAll] = useState(false);
    const [generateAllProgress, setGenerateAllProgress] = useState({
        completed: 0,
        total: 0,
        errors: 0,
    });
    const [showGenerateAllConfirm, setShowGenerateAllConfirm] = useState(false);
    const [remainingCount, setRemainingCount] = useState(0);
    const cancelRef = useRef(false);

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(comparisons.length / pageSize));
    const paginatedComparisons = useMemo(
        () => comparisons.slice((currentPage - 1) * pageSize, currentPage * pageSize),
        [comparisons, currentPage],
    );

    const handleGenerateNext = () => {
        startTransition(async () => {
            const result = await generateNextComparison(directoryId);

            if (result.status === 'success') {
                toast.success(result.message);
                // Refresh comparisons list
                window.location.reload();
            } else if (result.status === 'skipped') {
                toast.info(result.message);
            } else {
                toast.error(result.message);
            }
        });
    };

    const handleManualGenerate = () => {
        if (!selectedItemA || !selectedItemB) {
            toast.error('Please select two items to compare');
            return;
        }

        if (selectedItemA === selectedItemB) {
            toast.error('Cannot compare an item with itself');
            return;
        }

        startTransition(async () => {
            const result = await generateManualComparison(
                directoryId,
                selectedItemA,
                selectedItemB,
            );

            if (result.status === 'success') {
                toast.success(result.message);
                window.location.reload();
            } else if (result.status === 'skipped') {
                toast.info(result.message);
            } else {
                toast.error(result.message);
            }
        });
    };

    const handleDeleteConfirm = () => {
        if (!deleteSlug) return;
        const slug = deleteSlug;
        setDeleteSlug(null);

        startTransition(async () => {
            const result = await deleteComparison(directoryId, slug);

            if (result.status === 'success') {
                toast.success('Comparison deleted');
                setComparisons((prev) => {
                    const updated = prev.filter((c) => c.slug !== slug);
                    const newTotalPages = Math.max(1, Math.ceil(updated.length / pageSize));
                    if (currentPage > newTotalPages) {
                        setCurrentPage(newTotalPages);
                    }
                    return updated;
                });
            } else {
                toast.error(result.message);
            }
        });
    };

    const handleGenerateAllClick = async () => {
        const { count } = await getRemainingComparisonCount(directoryId);
        if (count === 0) {
            toast.info('No remaining pairs to generate');
            return;
        }
        setRemainingCount(count);
        setShowGenerateAllConfirm(true);
    };

    const handleGenerateAllConfirm = useCallback(async () => {
        setShowGenerateAllConfirm(false);
        setIsGeneratingAll(true);
        cancelRef.current = false;
        setGenerateAllProgress({ completed: 0, total: remainingCount, errors: 0 });

        let completed = 0;
        let errors = 0;
        let consecutiveErrors = 0;

        while (!cancelRef.current) {
            const result = await generateNextComparison(directoryId);

            if (result.status === 'success') {
                completed++;
                consecutiveErrors = 0;
                setGenerateAllProgress({ completed, total: remainingCount, errors });
            } else if (result.status === 'skipped') {
                break;
            } else {
                errors++;
                consecutiveErrors++;
                setGenerateAllProgress({ completed, total: remainingCount, errors });
                if (consecutiveErrors >= 3) {
                    toast.error('Stopped after 3 consecutive errors');
                    break;
                }
            }
        }

        setIsGeneratingAll(false);

        if (cancelRef.current) {
            toast.info(
                `Stopped. Generated ${completed} comparison${completed !== 1 ? 's' : ''}${errors > 0 ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}.`,
            );
        } else {
            toast.success(
                `Done! Generated ${completed} comparison${completed !== 1 ? 's' : ''}${errors > 0 ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}.`,
            );
        }

        window.location.reload();
    }, [directoryId, remainingCount]);

    const handleStopGenerateAll = () => {
        cancelRef.current = true;
    };

    const isBusy = isPending || isGeneratingAll;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-semibold text-text dark:text-text-dark">
                        Comparisons
                    </h2>
                    <p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                        A vs B comparison pages between directory items
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowManualForm(!showManualForm)}
                        disabled={isBusy || items.length < 2}
                    >
                        Compare Items
                    </Button>
                    <Button size="sm" onClick={handleGenerateNext} disabled={isBusy}>
                        {isPending ? 'Generating...' : 'Generate Next'}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={handleGenerateAllClick}
                        disabled={isBusy}
                    >
                        Generate All
                    </Button>
                </div>
            </div>

            {/* Generate All progress bar */}
            {isGeneratingAll && (
                <div className="rounded-lg border border-border dark:border-border-dark p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            Generating comparisons: {generateAllProgress.completed} /{' '}
                            {generateAllProgress.total} complete
                            {generateAllProgress.errors > 0 && (
                                <span className="text-danger ml-2">
                                    ({generateAllProgress.errors} error
                                    {generateAllProgress.errors !== 1 ? 's' : ''})
                                </span>
                            )}
                        </p>
                        <Button size="sm" variant="secondary" onClick={handleStopGenerateAll}>
                            <Square className="w-3 h-3 mr-1 fill-current" />
                            Stop
                        </Button>
                    </div>
                    <div className="w-full bg-surface-hover dark:bg-surface-hover-dark rounded-full h-2">
                        <div
                            className="bg-primary h-2 rounded-full transition-all duration-300"
                            style={{
                                width: `${generateAllProgress.total > 0 ? (generateAllProgress.completed / generateAllProgress.total) * 100 : 0}%`,
                            }}
                        />
                    </div>
                </div>
            )}

            {/* Manual comparison form */}
            {showManualForm && (
                <div className="rounded-lg border border-border dark:border-border-dark p-4 space-y-4">
                    <h3 className="text-lg font-medium text-text dark:text-text-dark">
                        Compare Two Items
                    </h3>
                    <div className="flex gap-4 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                Item A
                            </label>
                            <select
                                value={selectedItemA}
                                onChange={(e) => setSelectedItemA(e.target.value)}
                                className="w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-3 py-2 text-sm text-text dark:text-text-dark"
                            >
                                <option value="">Select item...</option>
                                {items
                                    .filter((item) => item.slug !== selectedItemB)
                                    .map((item) => (
                                        <option key={item.slug} value={item.slug}>
                                            {item.name}
                                        </option>
                                    ))}
                            </select>
                        </div>
                        <span className="pb-2 text-text-secondary dark:text-text-secondary-dark font-medium">
                            vs
                        </span>
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                Item B
                            </label>
                            <select
                                value={selectedItemB}
                                onChange={(e) => setSelectedItemB(e.target.value)}
                                className="w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-3 py-2 text-sm text-text dark:text-text-dark"
                            >
                                <option value="">Select item...</option>
                                {items
                                    .filter((item) => item.slug !== selectedItemA)
                                    .map((item) => (
                                        <option key={item.slug} value={item.slug}>
                                            {item.name}
                                        </option>
                                    ))}
                            </select>
                        </div>
                        <Button
                            size="sm"
                            onClick={handleManualGenerate}
                            disabled={isBusy || !selectedItemA || !selectedItemB}
                        >
                            {isPending ? 'Generating...' : 'Generate'}
                        </Button>
                    </div>
                </div>
            )}

            {/* View toggle */}
            {comparisons.length > 0 && (
                <div className="flex justify-end">
                    <div className="flex rounded-lg border border-border dark:border-border-dark">
                        <Button
                            variant={viewMode === 'list' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('list')}
                            className="rounded-r-none"
                        >
                            <List className="w-4 h-4" />
                        </Button>
                        <Button
                            variant={viewMode === 'grid' ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setViewMode('grid')}
                            className="rounded-l-none"
                        >
                            <Grid className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
            )}

            {/* Comparisons list */}
            {comparisons.length === 0 ? (
                <div className="text-center py-12 rounded-lg border border-dashed border-border dark:border-border-dark">
                    <svg
                        className="mx-auto h-12 w-12 text-text-secondary dark:text-text-secondary-dark"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3"
                        />
                    </svg>
                    <h3 className="mt-4 text-lg font-medium text-text dark:text-text-dark">
                        No comparisons yet
                    </h3>
                    <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                        Click &quot;Generate Next&quot; to auto-pick items, or &quot;Compare
                        Items&quot; to choose a specific pair.
                    </p>
                </div>
            ) : (
                <div
                    className={
                        viewMode === 'grid'
                            ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'
                            : 'space-y-3'
                    }
                >
                    {paginatedComparisons.map((comparison) => (
                        <div
                            key={comparison.slug}
                            className={`relative rounded-lg border border-border dark:border-border-dark p-4 hover:bg-surface-hover dark:hover:bg-surface-hover-dark transition-colors ${viewMode === 'grid' ? 'flex flex-col' : ''}`}
                        >
                            <Link
                                href={ROUTES.DASHBOARD_DIRECTORY_COMPARISON(
                                    directoryId,
                                    comparison.slug,
                                )}
                                className="absolute inset-0 rounded-lg"
                            />
                            <div
                                className={
                                    viewMode === 'grid'
                                        ? 'flex flex-col flex-1'
                                        : 'flex items-start justify-between'
                                }
                            >
                                <div className={viewMode === 'grid' ? '' : 'flex-1 min-w-0'}>
                                    <div className="flex items-start justify-between">
                                        <h3 className="font-medium text-text dark:text-text-dark truncate">
                                            {comparison.title}
                                        </h3>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setDeleteSlug(comparison.slug)}
                                            disabled={isBusy}
                                            className="relative z-10 text-text-secondary hover:text-red-600 dark:text-text-secondary-dark dark:hover:text-red-400 ml-2 shrink-0"
                                        >
                                            <svg
                                                className="w-4 h-4"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    strokeWidth={2}
                                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                                />
                                            </svg>
                                        </Button>
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                        <span>
                                            {comparison.item_a_name} vs {comparison.item_b_name}
                                        </span>
                                        <span className="text-border dark:text-border-dark">|</span>
                                        <span>{comparison.category}</span>
                                        <span className="text-border dark:text-border-dark">|</span>
                                        <span>
                                            {new Date(comparison.generated_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <p className="mt-2 text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                                        {comparison.summary}
                                    </p>
                                    {comparison.verdict_winner && (
                                        <div className="mt-2">
                                            <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                                                Winner:{' '}
                                                {comparison.verdict_winner === 'item_a'
                                                    ? comparison.item_a_name
                                                    : comparison.verdict_winner === 'item_b'
                                                      ? comparison.item_b_name
                                                      : 'Tie'}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Pagination */}
            {comparisons.length > pageSize && (
                <div className="flex items-center justify-between">
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        Showing {(currentPage - 1) * pageSize + 1}–
                        {Math.min(currentPage * pageSize, comparisons.length)} of{' '}
                        {comparisons.length}
                    </p>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCurrentPage((p) => p - 1)}
                            disabled={currentPage <= 1}
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <span className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {currentPage} / {totalPages}
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCurrentPage((p) => p + 1)}
                            disabled={currentPage >= totalPages}
                        >
                            <ChevronRight className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
            )}

            {/* Delete confirmation dialog */}
            <Dialog open={deleteSlug !== null} onOpenChange={(o) => !o && setDeleteSlug(null)}>
                <DialogContent>
                    <DialogClose onClose={() => setDeleteSlug(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-danger" />
                            Delete Comparison
                        </DialogTitle>
                    </DialogHeader>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        Are you sure you want to delete{' '}
                        <span className="font-medium text-text dark:text-text-dark">
                            {comparisons.find((c) => c.slug === deleteSlug)?.title ?? deleteSlug}
                        </span>
                        ? This action cannot be undone.
                    </p>

                    <DialogFooter>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteSlug(null)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleDeleteConfirm}
                            disabled={isPending}
                            loading={isPending}
                            className="text-danger hover:text-danger hover:bg-danger/10"
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {/* Generate All confirmation dialog */}
            <Dialog
                open={showGenerateAllConfirm}
                onOpenChange={(o) => !o && setShowGenerateAllConfirm(false)}
            >
                <DialogContent>
                    <DialogClose onClose={() => setShowGenerateAllConfirm(false)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            Generate All Comparisons
                        </DialogTitle>
                    </DialogHeader>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        Generate{' '}
                        <span className="font-medium text-text dark:text-text-dark">
                            {remainingCount}
                        </span>{' '}
                        remaining comparison{remainingCount !== 1 ? 's' : ''}? This may take several
                        minutes. You can stop at any time.
                    </p>

                    <DialogFooter>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowGenerateAllConfirm(false)}
                        >
                            Cancel
                        </Button>
                        <Button size="sm" onClick={handleGenerateAllConfirm}>
                            Generate All
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
