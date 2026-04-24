'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    Grid,
    List,
    Square,
} from 'lucide-react';
import {
    Combobox,
    ComboboxInput,
    ComboboxButton,
    ComboboxOptions,
    ComboboxOption,
} from '@headlessui/react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
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
import type { ProviderOption } from '@/lib/api/types-only';
import { ROUTES } from '@/lib/constants';
import { buildPublicComparisonUrl, formatComparisonDate } from '@/lib/utils/comparison';
import { ProviderSelector } from '@/components/directories/detail/generator/ProviderSelector';
import {
    generateNextComparison,
    generateManualComparison,
    deleteComparison,
    getRemainingComparisonCount,
    saveComparisonAiConfig,
    getAiProviderModels,
    listComparisons,
} from '@/app/actions/dashboard/comparisons';
import { ComparisonGenerationProgress } from './ComparisonGenerationProgress';

interface ComparisonsPageClientProps {
    directoryId: string;
    websiteUrl: string | null;
    initialComparisons: ComparisonData[];
    items: Array<{ slug: string; name: string; category: string | string[] }>;
    availableProviders: ProviderOption[];
    initialAiConfig: { provider: string | null; model: string | null; extendedAnalysis?: boolean };
}

export function ComparisonsPageClient({
    directoryId,
    websiteUrl,
    initialComparisons,
    items,
    availableProviders,
    initialAiConfig,
}: ComparisonsPageClientProps) {
    const t = useTranslations('dashboard.directoryDetail.comparisons');
    const [comparisons, setComparisons] = useState<ComparisonData[]>(initialComparisons);
    const [isPending, startTransition] = useTransition();
    const [selectedItemA, setSelectedItemA] = useState('');
    const [selectedItemB, setSelectedItemB] = useState('');
    const [queryA, setQueryA] = useState('');
    const [queryB, setQueryB] = useState('');
    const [showManualForm, setShowManualForm] = useState(false);
    const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
    const [currentPage, setCurrentPage] = useState(1);

    // AI Model settings state
    const [showAiSettings, setShowAiSettings] = useState(false);
    const [aiProvider, setAiProvider] = useState(initialAiConfig.provider ?? '');
    const [aiModel, setAiModel] = useState(initialAiConfig.model ?? '');
    const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [isSavingAiConfig, setIsSavingAiConfig] = useState(false);
    const [extendedAnalysis, setExtendedAnalysis] = useState(
        initialAiConfig.extendedAnalysis ?? false,
    );

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

    // Load models for the initially-configured provider
    useEffect(() => {
        if (!initialAiConfig.provider) return;
        let cancelled = false;
        setIsLoadingModels(true);
        getAiProviderModels(initialAiConfig.provider)
            .then((models) => {
                if (cancelled) return;
                setAvailableModels(
                    models.map((m: any) => ({
                        id: m.id ?? m.modelId ?? m,
                        name: m.name ?? m.id ?? m,
                    })),
                );
            })
            .catch(() => {
                if (!cancelled) setAvailableModels([]);
            })
            .finally(() => {
                if (!cancelled) setIsLoadingModels(false);
            });
        return () => {
            cancelled = true;
        };
    }, [initialAiConfig.provider]);

    const selectedItemAObj = items.find((item) => item.slug === selectedItemA) ?? null;
    const selectedItemBObj = items.find((item) => item.slug === selectedItemB) ?? null;
    const selectedProviderOption =
        availableProviders.find((provider) => provider.id === aiProvider) ?? null;
    const selectedProviderConfigured = selectedProviderOption?.configured ?? true;

    const filteredItemsA = items
        .filter((item) => item.slug !== selectedItemB)
        .filter((item) => queryA === '' || item.name.toLowerCase().includes(queryA.toLowerCase()));

    const filteredItemsB = items
        .filter((item) => item.slug !== selectedItemA)
        .filter((item) => queryB === '' || item.name.toLowerCase().includes(queryB.toLowerCase()));

    const refreshComparisons = useCallback(async () => {
        try {
            const updated = await listComparisons(directoryId);
            setComparisons(updated);
        } catch {
            // Fallback: reload if fetch fails
            window.location.reload();
        }
    }, [directoryId]);

    const handleGenerateNext = () => {
        startTransition(async () => {
            const result = await generateNextComparison(directoryId);

            if (result.status === 'success') {
                toast.success(result.message);
                await refreshComparisons();
            } else if (result.status === 'skipped') {
                toast.info(result.message);
            } else {
                toast.error(result.message);
            }
        });
    };

    const handleManualGenerate = () => {
        if (!selectedItemA || !selectedItemB) {
            toast.error(t('toast.selectTwo'));
            return;
        }

        if (selectedItemA === selectedItemB) {
            toast.error(t('toast.cannotCompareSelf'));
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
                await refreshComparisons();
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
                toast.success(t('toast.deleted'));
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
            toast.info(t('toast.noRemaining'));
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
                    toast.error(t('toast.consecutiveErrors'));
                    break;
                }
            }
        }

        setIsGeneratingAll(false);

        if (cancelRef.current) {
            toast.info(t('progress.stopped', { count: completed, errors }));
        } else {
            toast.success(t('progress.done', { count: completed }));
        }

        await refreshComparisons();
    }, [directoryId, refreshComparisons, remainingCount, t]);

    const handleStopGenerateAll = () => {
        cancelRef.current = true;
    };

    const handleProviderChange = async (providerId: string) => {
        setAiProvider(providerId);
        setAiModel('');
        setAvailableModels([]);

        const provider = availableProviders.find((entry) => entry.id === providerId);
        if (!providerId || !provider?.configured) return;

        setIsLoadingModels(true);
        try {
            const models = await getAiProviderModels(providerId);
            setAvailableModels(
                models.map((m: any) => ({ id: m.id ?? m.modelId ?? m, name: m.name ?? m.id ?? m })),
            );
        } catch {
            setAvailableModels([]);
        } finally {
            setIsLoadingModels(false);
        }
    };

    const handleSaveAiConfig = async () => {
        setIsSavingAiConfig(true);
        try {
            const result = await saveComparisonAiConfig(directoryId, {
                provider: aiProvider || null,
                model: aiModel || null,
                extendedAnalysis,
            });
            if (result.success) {
                toast.success(t('toast.aiConfigSaved'));
            } else {
                toast.error(result.error ?? t('toast.aiConfigFailed'));
            }
        } catch {
            toast.error(t('toast.aiConfigFailed'));
        } finally {
            setIsSavingAiConfig(false);
        }
    };

    const isBusy = isPending || isGeneratingAll;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowManualForm(!showManualForm)}
                        disabled={isBusy || items.length < 2}
                    >
                        {t('actions.compareItems')}
                    </Button>
                    <Button size="sm" onClick={handleGenerateNext} disabled={isBusy}>
                        {isPending ? t('actions.generating') : t('actions.generateNext')}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={handleGenerateAllClick}
                        disabled={isBusy}
                    >
                        {t('actions.generateAll')}
                    </Button>
                </div>
            </div>

            {/* AI Model */}
            {availableProviders.length > 0 && (
                <div className="rounded-lg border border-border dark:border-border-dark">
                    <button
                        type="button"
                        onClick={() => setShowAiSettings(!showAiSettings)}
                        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-text dark:text-text-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark transition-colors rounded-lg"
                    >
                        <span>{t('aiModel.title')}</span>
                        <ChevronDown
                            className={cn(
                                'h-4 w-4 text-text-muted transition-transform duration-200',
                                showAiSettings && 'rotate-180',
                            )}
                        />
                    </button>
                    {showAiSettings && (
                        <div className="border-t border-border dark:border-border-dark px-4 py-4 space-y-4">
                            <div className="space-y-4">
                                <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark">
                                    <div className="border-b border-border dark:border-border-dark px-5 py-3">
                                        <p className="text-sm font-medium text-text dark:text-text-dark">
                                            {t('aiModel.provider')}
                                        </p>
                                    </div>
                                    <ProviderSelector
                                        label={t('aiModel.provider')}
                                        providers={availableProviders}
                                        value={aiProvider || null}
                                        onChange={(providerId) =>
                                            handleProviderChange(providerId ?? '')
                                        }
                                        disabled={isSavingAiConfig}
                                    />
                                </div>
                                <div className="flex gap-4 items-end">
                                    <div className="flex-1">
                                        <label className="block text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                            {t('aiModel.model')}
                                        </label>
                                        <Select
                                            value={aiModel || '__provider_default__'}
                                            onValueChange={(val) =>
                                                setAiModel(
                                                    val === '__provider_default__' ? '' : val,
                                                )
                                            }
                                            disabled={
                                                !aiProvider ||
                                                !selectedProviderConfigured ||
                                                isLoadingModels
                                            }
                                        >
                                            <option value="__provider_default__">
                                                {isLoadingModels
                                                    ? t('aiModel.loadingModels')
                                                    : t('aiModel.providerDefault')}
                                            </option>
                                            {availableModels.map((m) => (
                                                <option key={m.id} value={m.id}>
                                                    {m.name}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                    <Button
                                        size="sm"
                                        onClick={handleSaveAiConfig}
                                        disabled={isSavingAiConfig || !selectedProviderConfigured}
                                        loading={isSavingAiConfig}
                                    >
                                        {t('actions.save')}
                                    </Button>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-text dark:text-text-dark">
                                        {t('aiModel.extendedAnalysisLabel')}
                                    </p>
                                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {t('aiModel.extendedAnalysisDescription')}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={extendedAnalysis}
                                    onClick={() => setExtendedAnalysis(!extendedAnalysis)}
                                    className={cn(
                                        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary/20',
                                        extendedAnalysis
                                            ? 'bg-primary'
                                            : 'bg-surface-hover dark:bg-surface-hover-dark',
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                                            extendedAnalysis ? 'translate-x-4' : 'translate-x-0',
                                        )}
                                    />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Single generation progress */}
            <ComparisonGenerationProgress directoryId={directoryId} isGenerating={isPending} />

            {/* Generate All progress bar */}
            {isGeneratingAll && (
                <div className="rounded-lg border border-border dark:border-border-dark p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('progress.generating', {
                                completed: generateAllProgress.completed,
                                total: generateAllProgress.total,
                            })}
                            {generateAllProgress.errors > 0 && (
                                <span className="text-danger ml-2">
                                    ({t('progress.error', { count: generateAllProgress.errors })})
                                </span>
                            )}
                        </p>
                        <Button size="sm" variant="secondary" onClick={handleStopGenerateAll}>
                            <Square className="w-3 h-3 mr-1 fill-current" />
                            {t('actions.stop')}
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
                        {t('manualForm.title')}
                    </h3>
                    <div className="flex gap-4 items-end">
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                {t('manualForm.itemA')}
                            </label>
                            <Combobox
                                value={selectedItemAObj}
                                onChange={(item) => {
                                    setSelectedItemA(item?.slug ?? '');
                                    setQueryA('');
                                }}
                                onClose={() => setQueryA('')}
                                by="slug"
                            >
                                <div className="relative">
                                    <div
                                        className={cn(
                                            'relative rounded-lg border border-border dark:border-border-dark',
                                            'bg-surface dark:bg-surface-dark',
                                            'focus-within:border-primary dark:focus-within:border-primary-dark',
                                            'focus-within:ring-2 focus-within:ring-primary/20',
                                        )}
                                    >
                                        <ComboboxInput
                                            className={cn(
                                                'w-full bg-transparent border-none outline-none px-3 py-2 pr-8',
                                                'text-sm text-text dark:text-text-dark',
                                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                            )}
                                            displayValue={(item: typeof selectedItemAObj) =>
                                                item?.name ?? ''
                                            }
                                            onChange={(e) => setQueryA(e.target.value)}
                                            placeholder={t('manualForm.searchPlaceholder')}
                                        />
                                        <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-3">
                                            {({ open }) => (
                                                <ChevronDown
                                                    className={cn(
                                                        'h-4 w-4 text-text-muted transition-transform duration-200',
                                                        open && 'rotate-180',
                                                    )}
                                                />
                                            )}
                                        </ComboboxButton>
                                    </div>
                                    <ComboboxOptions
                                        className={cn(
                                            'absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg',
                                            'bg-surface dark:bg-surface-dark',
                                            'border border-border dark:border-border-dark',
                                            'shadow-lg focus:outline-none',
                                            'py-1',
                                        )}
                                    >
                                        {filteredItemsA.length === 0 ? (
                                            <div className="py-2 px-4 text-sm text-text-muted dark:text-text-muted-dark">
                                                {t('manualForm.noItems')}
                                            </div>
                                        ) : (
                                            filteredItemsA.map((item) => (
                                                <ComboboxOption
                                                    key={item.slug}
                                                    value={item}
                                                    className={({ active, selected }) =>
                                                        cn(
                                                            'relative cursor-pointer select-none py-2 pl-10 pr-4',
                                                            'text-text dark:text-text-dark',
                                                            active &&
                                                                'bg-surface-hover dark:bg-surface-hover-dark',
                                                            selected &&
                                                                'bg-primary/5 dark:bg-primary-dark/5',
                                                        )
                                                    }
                                                >
                                                    {({ selected }) => (
                                                        <>
                                                            <span
                                                                className={cn(
                                                                    'block truncate',
                                                                    selected && 'font-medium',
                                                                )}
                                                            >
                                                                {item.name}
                                                            </span>
                                                            {(Array.isArray(item.category)
                                                                ? item.category.length > 0
                                                                : item.category) && (
                                                                <span className="block truncate text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                    {Array.isArray(item.category)
                                                                        ? item.category.join(', ')
                                                                        : item.category}
                                                                </span>
                                                            )}
                                                            {selected && (
                                                                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-primary dark:text-primary-dark">
                                                                    <Check className="h-4 w-4" />
                                                                </span>
                                                            )}
                                                        </>
                                                    )}
                                                </ComboboxOption>
                                            ))
                                        )}
                                    </ComboboxOptions>
                                </div>
                            </Combobox>
                        </div>
                        <span className="pb-2 text-text-secondary dark:text-text-secondary-dark font-medium">
                            {t('vs')}
                        </span>
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                {t('manualForm.itemB')}
                            </label>
                            <Combobox
                                value={selectedItemBObj}
                                onChange={(item) => {
                                    setSelectedItemB(item?.slug ?? '');
                                    setQueryB('');
                                }}
                                onClose={() => setQueryB('')}
                                by="slug"
                            >
                                <div className="relative">
                                    <div
                                        className={cn(
                                            'relative rounded-lg border border-border dark:border-border-dark',
                                            'bg-surface dark:bg-surface-dark',
                                            'focus-within:border-primary dark:focus-within:border-primary-dark',
                                            'focus-within:ring-2 focus-within:ring-primary/20',
                                        )}
                                    >
                                        <ComboboxInput
                                            className={cn(
                                                'w-full bg-transparent border-none outline-none px-3 py-2 pr-8',
                                                'text-sm text-text dark:text-text-dark',
                                                'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                            )}
                                            displayValue={(item: typeof selectedItemBObj) =>
                                                item?.name ?? ''
                                            }
                                            onChange={(e) => setQueryB(e.target.value)}
                                            placeholder={t('manualForm.searchPlaceholder')}
                                        />
                                        <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-3">
                                            {({ open }) => (
                                                <ChevronDown
                                                    className={cn(
                                                        'h-4 w-4 text-text-muted transition-transform duration-200',
                                                        open && 'rotate-180',
                                                    )}
                                                />
                                            )}
                                        </ComboboxButton>
                                    </div>
                                    <ComboboxOptions
                                        className={cn(
                                            'absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg',
                                            'bg-surface dark:bg-surface-dark',
                                            'border border-border dark:border-border-dark',
                                            'shadow-lg focus:outline-none',
                                            'py-1',
                                        )}
                                    >
                                        {filteredItemsB.length === 0 ? (
                                            <div className="py-2 px-4 text-sm text-text-muted dark:text-text-muted-dark">
                                                {t('manualForm.noItems')}
                                            </div>
                                        ) : (
                                            filteredItemsB.map((item) => (
                                                <ComboboxOption
                                                    key={item.slug}
                                                    value={item}
                                                    className={({ active, selected }) =>
                                                        cn(
                                                            'relative cursor-pointer select-none py-2 pl-10 pr-4',
                                                            'text-text dark:text-text-dark',
                                                            active &&
                                                                'bg-surface-hover dark:bg-surface-hover-dark',
                                                            selected &&
                                                                'bg-primary/5 dark:bg-primary-dark/5',
                                                        )
                                                    }
                                                >
                                                    {({ selected }) => (
                                                        <>
                                                            <span
                                                                className={cn(
                                                                    'block truncate',
                                                                    selected && 'font-medium',
                                                                )}
                                                            >
                                                                {item.name}
                                                            </span>
                                                            {(Array.isArray(item.category)
                                                                ? item.category.length > 0
                                                                : item.category) && (
                                                                <span className="block truncate text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                    {Array.isArray(item.category)
                                                                        ? item.category.join(', ')
                                                                        : item.category}
                                                                </span>
                                                            )}
                                                            {selected && (
                                                                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-primary dark:text-primary-dark">
                                                                    <Check className="h-4 w-4" />
                                                                </span>
                                                            )}
                                                        </>
                                                    )}
                                                </ComboboxOption>
                                            ))
                                        )}
                                    </ComboboxOptions>
                                </div>
                            </Combobox>
                        </div>
                        <Button
                            size="sm"
                            onClick={handleManualGenerate}
                            disabled={isBusy || !selectedItemA || !selectedItemB}
                        >
                            {isPending ? t('actions.generating') : t('actions.generate')}
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
                        {t('empty.title')}
                    </h3>
                    <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                        {t('empty.description')}
                    </p>
                </div>
            ) : (
                <div
                    className={
                        viewMode === 'grid'
                            ? 'grid grid-cols-1 @sm/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4'
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
                                        <div className="relative z-10 ml-2 flex shrink-0 items-center gap-1">
                                            {websiteUrl && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    href={buildPublicComparisonUrl(
                                                        websiteUrl,
                                                        comparison.slug,
                                                    )}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-text-secondary dark:text-text-secondary-dark"
                                                >
                                                    <ExternalLink className="w-4 h-4" />
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setDeleteSlug(comparison.slug)}
                                                disabled={isBusy}
                                                className="text-text-secondary hover:text-red-600 dark:text-text-secondary-dark dark:hover:text-red-400"
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
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                        <span>
                                            {comparison.item_a_name} {t('vs')}{' '}
                                            {comparison.item_b_name}
                                        </span>
                                        <span className="text-border dark:text-border-dark">|</span>
                                        <span>{comparison.category}</span>
                                        <span className="text-border dark:text-border-dark">|</span>
                                        <span>{formatComparisonDate(comparison.generated_at)}</span>
                                    </div>
                                    <p className="mt-2 text-sm text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                                        {comparison.summary}
                                    </p>
                                    {comparison.verdict_winner && (
                                        <div className="mt-2">
                                            <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                                                {t('winner', {
                                                    name:
                                                        comparison.verdict_winner === 'item_a'
                                                            ? comparison.item_a_name
                                                            : comparison.verdict_winner === 'item_b'
                                                              ? comparison.item_b_name
                                                              : t('tie'),
                                                })}
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
                        {t('pagination.showing', {
                            from: (currentPage - 1) * pageSize + 1,
                            to: Math.min(currentPage * pageSize, comparisons.length),
                            total: comparisons.length,
                        })}
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
                            {t('deleteDialog.title')}
                        </DialogTitle>
                    </DialogHeader>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('deleteDialog.confirmation', {
                            title:
                                comparisons.find((c) => c.slug === deleteSlug)?.title ??
                                deleteSlug ??
                                '',
                        })}
                    </p>

                    <DialogFooter>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteSlug(null)}>
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleDeleteConfirm}
                            disabled={isPending}
                            loading={isPending}
                            className="text-danger hover:text-danger hover:bg-danger/10"
                        >
                            {t('actions.delete')}
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
                            {t('generateAllDialog.title')}
                        </DialogTitle>
                    </DialogHeader>

                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('generateAllDialog.confirmation', { count: remainingCount })}
                    </p>

                    <DialogFooter>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowGenerateAllConfirm(false)}
                        >
                            {t('actions.cancel')}
                        </Button>
                        <Button size="sm" onClick={handleGenerateAllConfirm}>
                            {t('actions.generateAll')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
