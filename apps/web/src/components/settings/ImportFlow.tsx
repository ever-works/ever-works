'use client';

import { useState, useTransition, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Upload, AlertTriangle, Check, X, FileJson } from 'lucide-react';
import { previewImport, applyImport, applyPull } from '@/app/actions/account-transfer';
import type {
    AccountExportPayload,
    ImportPreview,
    ConflictResolution,
    ImportResult,
} from '@/lib/api/account-transfer.types';

interface ImportFlowProps {
    onClose: () => void;
    initialPreview?: ImportPreview;
    isPullMode?: boolean;
}

type ImportStep = 'upload' | 'preview' | 'result';

export function ImportFlow({ onClose, initialPreview, isPullMode }: ImportFlowProps) {
    const t = useTranslations('dashboard.settings.data.import');
    const [step, setStep] = useState<ImportStep>(initialPreview ? 'preview' : 'upload');
    const [payload, setPayload] = useState<AccountExportPayload | null>(null);
    const [preview, setPreview] = useState<ImportPreview | null>(initialPreview || null);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [resolutions, setResolutions] = useState<Map<string, ConflictResolution>>(() => {
        const map = new Map<string, ConflictResolution>();
        if (initialPreview) {
            for (const conflict of initialPreview.conflicts) {
                map.set(conflict.slug, { slug: conflict.slug, strategy: 'skip' });
            }
        }
        return map;
    });
    const [isPending, startTransition] = useTransition();
    const [dragOver, setDragOver] = useState(false);

    const handleFile = useCallback(
        (file: File) => {
            if (!file.name.endsWith('.json')) {
                toast.error(t('invalidFileType'));
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target?.result as string) as AccountExportPayload;
                    setPayload(data);

                    startTransition(async () => {
                        try {
                            const result = await previewImport(data);
                            if (!result.success || !result.data) {
                                toast.error(result.error || t('previewError'));
                                return;
                            }
                            setPreview(result.data);
                            setStep('preview');

                            const initialResolutions = new Map<string, ConflictResolution>();
                            for (const conflict of result.data.conflicts) {
                                initialResolutions.set(conflict.slug, {
                                    slug: conflict.slug,
                                    strategy: 'skip',
                                });
                            }
                            setResolutions(initialResolutions);
                        } catch {
                            toast.error(t('previewError'));
                        }
                    });
                } catch {
                    toast.error(t('invalidJson'));
                }
            };
            reader.readAsText(file);
        },
        [t, startTransition],
    );

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
        },
        [handleFile],
    );

    const handleApply = () => {
        startTransition(async () => {
            try {
                const resolutionsList = Array.from(resolutions.values());
                let importResult: ImportResult | null;

                if (isPullMode) {
                    const res = await applyPull(resolutionsList);
                    importResult = res.success ? res.data : null;
                    if (!res.success) {
                        toast.error(res.error || t('importError'));
                        return;
                    }
                } else if (payload) {
                    const res = await applyImport(payload, resolutionsList);
                    importResult = res.success ? res.data : null;
                    if (!res.success) {
                        toast.error(res.error || t('importError'));
                        return;
                    }
                } else {
                    return;
                }

                if (importResult) {
                    setResult(importResult);
                    setStep('result');
                    if (importResult.success) {
                        toast.success(t('importSuccess'));
                    } else {
                        toast.error(t('importFailed'));
                    }
                }
            } catch {
                toast.error(t('importError'));
            }
        });
    };

    const updateResolution = (slug: string, strategy: 'skip' | 'overwrite' | 'rename') => {
        setResolutions((prev) => {
            const next = new Map(prev);
            next.set(slug, { slug, strategy });
            return next;
        });
    };

    // Upload step
    if (step === 'upload') {
        return (
            <div className="space-y-4">
                <div
                    onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-10 text-center transition-all duration-200 ${
                        dragOver
                            ? 'border-primary bg-primary/5 scale-[1.01]'
                            : 'border-border dark:border-border-dark hover:border-border/70 dark:hover:border-border-dark/70'
                    }`}
                >
                    <div
                        className={`w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center border transition-all duration-200 ${
                            dragOver
                                ? 'bg-primary/10 border-primary/20'
                                : 'bg-surface-secondary dark:bg-surface-secondary-dark border-border/50 dark:border-border-dark/50'
                        }`}
                    >
                        <FileJson
                            className={`w-7 h-7 stroke-1 transition-colors duration-200 ${
                                dragOver
                                    ? 'text-primary'
                                    : 'text-text-muted dark:text-text-muted-dark'
                            }`}
                        />
                    </div>
                    <p className="text-sm font-medium text-text dark:text-text-dark mb-1">
                        {t('dropzone')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-5">.json</p>
                    <label className="cursor-pointer">
                        <input
                            type="file"
                            accept=".json"
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFile(file);
                            }}
                        />
                        <span className="inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 px-4 h-9 text-sm bg-surface-secondary dark:bg-surface-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/10 hover:shadow-sm active:scale-[0.97] border border-border dark:border-border-dark text-text dark:text-text-dark">
                            <Upload className="w-3 h-3" />
                            {isPending ? t('analyzing') : t('selectFile')}
                        </span>
                    </label>
                </div>
                <Button
                    variant="ghost"
                    onClick={onClose}
                    size="sm"
                    className="h-8 px-3 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark active:scale-[0.97] transition-all duration-150"
                >
                    {t('cancel')}
                </Button>
            </div>
        );
    }

    // Preview step
    if (step === 'preview' && preview) {
        return (
            <div className="space-y-5">
                {!preview.valid ? (
                    <div className="p-5 rounded-xl bg-destructive/10 border border-destructive/20">
                        <h3 className="font-medium text-destructive mb-2">
                            {t('validationErrors')}
                        </h3>
                        <ul className="list-disc list-inside text-sm space-y-1.5">
                            {preview.errors.map((err, i) => (
                                <li key={i}>{err}</li>
                            ))}
                        </ul>
                    </div>
                ) : (
                    <>
                        {/* Summary */}
                        <div className="rounded-xl border border-border/50 dark:border-border-dark/50 overflow-hidden">
                            <div className="px-4 py-3 border-b border-border/40 dark:border-border-dark/40 bg-surface-secondary dark:bg-surface-secondary-dark">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
                                    {t('summary')}
                                </h3>
                            </div>
                            <div className="divide-y divide-border/30 dark:divide-border-dark/30">
                                <div className="px-4 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('works')}
                                    </span>
                                    <span className="font-semibold text-text dark:text-text-dark tabular-nums">
                                        {preview.directoryCount}
                                    </span>
                                </div>
                                <div className="px-4 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('items')}
                                    </span>
                                    <span className="font-semibold text-text dark:text-text-dark tabular-nums">
                                        {preview.totalItemCount}
                                    </span>
                                </div>
                                <div className="px-4 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('userPlugins')}
                                    </span>
                                    <span className="font-semibold text-text dark:text-text-dark tabular-nums">
                                        {preview.userPluginCount}
                                    </span>
                                </div>
                                <div className="px-4 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('version')}
                                    </span>
                                    <code className="text-xs font-mono text-text dark:text-text-dark bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 rounded border border-border/40 dark:border-border-dark/40">
                                        {preview.version}
                                    </code>
                                </div>
                            </div>
                        </div>

                        {/* Missing plugins warning */}
                        {preview.missingPlugins.length > 0 && (
                            <div className="p-3.5 rounded-xl bg-warning/10 border border-warning/20">
                                <div className="flex items-center gap-2 mb-1.5">
                                    <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                                    <span className="text-sm font-medium">
                                        {t('missingPlugins')}
                                    </span>
                                </div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                    {preview.missingPlugins.join(', ')}
                                </p>
                            </div>
                        )}

                        {/* Conflicts */}
                        {preview.conflicts.length > 0 && (
                            <div className="space-y-2.5">
                                <h3 className="font-medium text-sm text-text dark:text-text-dark">
                                    {t('conflicts')}
                                </h3>
                                {preview.conflicts.map((conflict) => (
                                    <div
                                        key={conflict.slug}
                                        className="rounded-xl border border-border dark:border-border-dark overflow-hidden"
                                    >
                                        <div className="px-4 py-3 border-b border-border/40 dark:border-border-dark/40 bg-surface-secondary dark:bg-surface-secondary-dark">
                                            <code className="text-xs font-mono text-text dark:text-text-dark">
                                                {conflict.slug}
                                            </code>
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 leading-relaxed">
                                                {t('existingWork')}: &quot;
                                                {conflict.existingName}&quot; &rarr; &quot;
                                                {conflict.incomingName}&quot;
                                            </p>
                                        </div>
                                        <div className="px-4 py-3">
                                            <select
                                                value={
                                                    resolutions.get(conflict.slug)?.strategy ||
                                                    'skip'
                                                }
                                                onChange={(e) =>
                                                    updateResolution(
                                                        conflict.slug,
                                                        e.target.value as
                                                            | 'skip'
                                                            | 'overwrite'
                                                            | 'rename',
                                                    )
                                                }
                                                className="text-sm rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2.5 py-1.5 transition-colors duration-150"
                                            >
                                                <option value="skip">{t('strategySkip')}</option>
                                                <option value="overwrite">
                                                    {t('strategyOverwrite')}
                                                </option>
                                                <option value="rename">
                                                    {t('strategyRename')}
                                                </option>
                                            </select>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Secrets notice */}
                        {/* Masked secrets warning — user needs to replace placeholders */}
                        {preview.hasMaskedSecrets && (
                            <div className="p-3.5 rounded-xl bg-warning/10 border border-warning/20 text-sm flex items-start gap-2">
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
                                <span className="leading-relaxed">{t('maskedSecretsWarning')}</span>
                            </div>
                        )}

                        {preview.includesSecrets && !preview.hasMaskedSecrets && (
                            <div className="p-3.5 rounded-xl bg-warning/10 border border-warning/20 text-sm flex items-start gap-2">
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
                                <span className="leading-relaxed">{t('secretsIncluded')}</span>
                            </div>
                        )}
                    </>
                )}

                <div className="flex gap-2.5">
                    {preview.valid && (
                        <Button
                            onClick={handleApply}
                            disabled={isPending}
                            size="sm"
                            className="h-8 px-3.5 font-medium shadow-sm hover:shadow active:scale-[0.97] transition-all duration-150"
                        >
                            {isPending ? t('applying') : t('applyImport')}
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        size="sm"
                        className="h-8 px-3 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark active:scale-[0.97] transition-all duration-150"
                    >
                        {t('cancel')}
                    </Button>
                </div>
            </div>
        );
    }

    // Result step
    if (step === 'result' && result) {
        return (
            <div className="space-y-4">
                <div
                    className={`rounded-xl border overflow-hidden ${
                        result.success
                            ? 'border-green-200 dark:border-green-800'
                            : 'border-destructive/20'
                    }`}
                >
                    <div
                        className={`px-5 py-4 flex items-center gap-3 border-b ${
                            result.success
                                ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                                : 'bg-destructive/10 border-destructive/20'
                        }`}
                    >
                        <div
                            className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                                result.success
                                    ? 'bg-green-100 dark:bg-green-900/40'
                                    : 'bg-destructive/15'
                            }`}
                        >
                            {result.success ? (
                                <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
                            ) : (
                                <X className="w-4 h-4 text-destructive" />
                            )}
                        </div>
                        <h3 className="font-semibold text-sm">
                            {result.success ? t('resultSuccess') : t('resultFailed')}
                        </h3>
                    </div>

                    {(result.directoriesCreated > 0 ||
                        result.directoriesUpdated > 0 ||
                        result.directoriesSkipped > 0 ||
                        result.userPluginsImported > 0) && (
                        <div className="divide-y divide-border/30 dark:divide-border-dark/30">
                            {result.directoriesCreated > 0 && (
                                <div className="px-5 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('worksCreated')}
                                    </span>
                                    <span className="font-semibold tabular-nums text-text dark:text-text-dark">
                                        {result.directoriesCreated}
                                    </span>
                                </div>
                            )}
                            {result.directoriesUpdated > 0 && (
                                <div className="px-5 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('worksUpdated')}
                                    </span>
                                    <span className="font-semibold tabular-nums text-text dark:text-text-dark">
                                        {result.directoriesUpdated}
                                    </span>
                                </div>
                            )}
                            {result.directoriesSkipped > 0 && (
                                <div className="px-5 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('worksSkipped')}
                                    </span>
                                    <span className="font-semibold tabular-nums text-text dark:text-text-dark">
                                        {result.directoriesSkipped}
                                    </span>
                                </div>
                            )}
                            {result.userPluginsImported > 0 && (
                                <div className="px-5 py-2.5 flex items-center justify-between text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('pluginsImported')}
                                    </span>
                                    <span className="font-semibold tabular-nums text-text dark:text-text-dark">
                                        {result.userPluginsImported}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {result.warnings.length > 0 && (
                    <div className="rounded-xl border border-warning/20 overflow-hidden">
                        <div className="px-4 py-2.5 bg-warning/10 border-b border-warning/20">
                            <h4 className="text-xs font-semibold uppercase tracking-wider text-warning-foreground/80">
                                {t('warnings')}
                            </h4>
                        </div>
                        <ul className="px-4 py-3 space-y-1.5 text-xs">
                            {result.warnings.map((w, i) => (
                                <li
                                    key={i}
                                    className="flex items-start gap-2 text-text-muted dark:text-text-muted-dark"
                                >
                                    <span className="mt-1.5 w-1 h-1 rounded-full bg-warning shrink-0" />
                                    {w}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {result.errors.length > 0 && (
                    <div className="rounded-xl border border-destructive/20 overflow-hidden">
                        <div className="px-4 py-2.5 bg-destructive/10 border-b border-destructive/20">
                            <h4 className="text-xs font-semibold uppercase tracking-wider text-destructive/80">
                                {t('errors')}
                            </h4>
                        </div>
                        <ul className="px-4 py-3 space-y-1.5 text-xs">
                            {result.errors.map((e, i) => (
                                <li
                                    key={i}
                                    className="flex items-start gap-2 text-text-muted dark:text-text-muted-dark"
                                >
                                    <span className="mt-1.5 w-1 h-1 rounded-full bg-destructive shrink-0" />
                                    {e}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <Button
                    variant="ghost"
                    onClick={onClose}
                    size="sm"
                    className="h-8 px-3 text-xs font-medium text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark active:scale-[0.97] transition-all duration-150"
                >
                    {t('done')}
                </Button>
            </div>
        );
    }

    return null;
}
