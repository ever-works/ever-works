'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { ComparisonData } from '@/lib/api/directory';
import { ROUTES } from '@/lib/constants';
import {
    generateNextComparison,
    generateManualComparison,
    deleteComparison,
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

    const handleDelete = (slug: string) => {
        startTransition(async () => {
            const result = await deleteComparison(directoryId, slug);

            if (result.status === 'success') {
                toast.success('Comparison deleted');
                setComparisons((prev) => prev.filter((c) => c.slug !== slug));
            } else {
                toast.error(result.message);
            }
        });
    };

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
                        onClick={() => setShowManualForm(!showManualForm)}
                        disabled={isPending || items.length < 2}
                    >
                        Compare Items
                    </Button>
                    <Button onClick={handleGenerateNext} disabled={isPending}>
                        {isPending ? 'Generating...' : 'Generate Next'}
                    </Button>
                </div>
            </div>

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
                            onClick={handleManualGenerate}
                            disabled={isPending || !selectedItemA || !selectedItemB}
                        >
                            {isPending ? 'Generating...' : 'Generate'}
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
                <div className="space-y-3">
                    {comparisons.map((comparison) => (
                        <Link
                            key={comparison.slug}
                            href={ROUTES.DASHBOARD_DIRECTORY_COMPARISON(directoryId, comparison.slug)}
                            className="block rounded-lg border border-border dark:border-border-dark p-4 hover:bg-surface-hover dark:hover:bg-surface-hover-dark transition-colors cursor-pointer"
                        >
                            <div className="flex items-start justify-between">
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-medium text-text dark:text-text-dark truncate">
                                        {comparison.title}
                                    </h3>
                                    <div className="mt-1 flex items-center gap-3 text-sm text-text-secondary dark:text-text-secondary-dark">
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
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleDelete(comparison.slug);
                                    }}
                                    disabled={isPending}
                                    className="text-text-secondary hover:text-red-600 dark:text-text-secondary-dark dark:hover:text-red-400 ml-4 shrink-0"
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
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
