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
    initialPayload?: AccountExportPayload;
    initialPreview?: ImportPreview;
    isPullMode?: boolean;
}

type ImportStep = 'upload' | 'preview' | 'result';

export function ImportFlow({
    onClose,
    initialPayload,
    initialPreview,
    isPullMode,
}: ImportFlowProps) {
    const t = useTranslations('dashboard.settings.data.import');
    const [step, setStep] = useState<ImportStep>(initialPreview ? 'preview' : 'upload');
    const [payload, setPayload] = useState<AccountExportPayload | null>(initialPayload || null);
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
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                        dragOver
                            ? 'border-primary bg-primary/5'
                            : 'border-border dark:border-border-dark'
                    }`}
                >
                    <FileJson className="w-10 h-10 mx-auto mb-3 text-text-muted dark:text-text-muted-dark" />
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mb-3">
                        {t('dropzone')}
                    </p>
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
                        <span className="inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors px-4 py-3 bg-surface-secondary dark:bg-surface-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark border border-border dark:border-border-dark text-text dark:text-text-dark">
                            <Upload className="w-4 h-4" />
                            {isPending ? t('analyzing') : t('selectFile')}
                        </span>
                    </label>
                </div>
                <Button variant="ghost" onClick={onClose} size="sm">
                    {t('cancel')}
                </Button>
            </div>
        );
    }

    // Preview step
    if (step === 'preview' && preview) {
        return (
            <div className="space-y-4">
                {!preview.valid ? (
                    <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
                        <h3 className="font-medium text-destructive mb-2">
                            {t('validationErrors')}
                        </h3>
                        <ul className="list-disc list-inside text-sm space-y-1">
                            {preview.errors.map((err, i) => (
                                <li key={i}>{err}</li>
                            ))}
                        </ul>
                    </div>
                ) : (
                    <>
                        {/* Summary */}
                        <div className="p-4 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                            <h3 className="font-medium text-text dark:text-text-dark mb-2">
                                {t('summary')}
                            </h3>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <span className="text-text-muted dark:text-text-muted-dark">
                                    {t('directories')}:
                                </span>
                                <span className="text-text dark:text-text-dark">
                                    {preview.directoryCount}
                                </span>
                                <span className="text-text-muted dark:text-text-muted-dark">
                                    {t('userPlugins')}:
                                </span>
                                <span className="text-text dark:text-text-dark">
                                    {preview.userPluginCount}
                                </span>
                                <span className="text-text-muted dark:text-text-muted-dark">
                                    {t('version')}:
                                </span>
                                <span className="text-text dark:text-text-dark">
                                    {preview.version}
                                </span>
                            </div>
                        </div>

                        {/* Missing plugins warning */}
                        {preview.missingPlugins.length > 0 && (
                            <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
                                <div className="flex items-center gap-2 mb-1">
                                    <AlertTriangle className="w-4 h-4 text-warning" />
                                    <span className="text-sm font-medium">
                                        {t('missingPlugins')}
                                    </span>
                                </div>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {preview.missingPlugins.join(', ')}
                                </p>
                            </div>
                        )}

                        {/* Conflicts */}
                        {preview.conflicts.length > 0 && (
                            <div className="space-y-3">
                                <h3 className="font-medium text-text dark:text-text-dark">
                                    {t('conflicts')}
                                </h3>
                                {preview.conflicts.map((conflict) => (
                                    <div
                                        key={conflict.slug}
                                        className="p-3 rounded-lg border border-border dark:border-border-dark"
                                    >
                                        <div className="text-sm mb-2">
                                            <span className="font-medium">{conflict.slug}</span>
                                            <span className="text-text-muted dark:text-text-muted-dark">
                                                {' '}
                                                — {t('existingDirectory')}: &quot;
                                                {conflict.existingName}
                                                &quot;, {t('incoming')}: &quot;
                                                {conflict.incomingName}&quot;
                                            </span>
                                        </div>
                                        <select
                                            value={
                                                resolutions.get(conflict.slug)?.strategy || 'skip'
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
                                            className="text-sm rounded border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 py-1"
                                        >
                                            <option value="skip">{t('strategySkip')}</option>
                                            <option value="overwrite">
                                                {t('strategyOverwrite')}
                                            </option>
                                            <option value="rename">{t('strategyRename')}</option>
                                        </select>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Secrets notice */}
                        {preview.includesSecrets && (
                            <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm">
                                <AlertTriangle className="w-4 h-4 inline mr-1 text-warning" />
                                {t('secretsIncluded')}
                            </div>
                        )}
                    </>
                )}

                <div className="flex gap-2">
                    {preview.valid && (
                        <Button onClick={handleApply} disabled={isPending} size="sm">
                            {isPending ? t('applying') : t('applyImport')}
                        </Button>
                    )}
                    <Button variant="ghost" onClick={onClose} size="sm">
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
                    className={`p-4 rounded-lg border ${
                        result.success
                            ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                            : 'bg-destructive/10 border-destructive/20'
                    }`}
                >
                    <div className="flex items-center gap-2 mb-2">
                        {result.success ? (
                            <Check className="w-5 h-5 text-green-600" />
                        ) : (
                            <X className="w-5 h-5 text-destructive" />
                        )}
                        <h3 className="font-medium">
                            {result.success ? t('resultSuccess') : t('resultFailed')}
                        </h3>
                    </div>

                    <div className="text-sm space-y-1">
                        {result.directoriesCreated > 0 && (
                            <p>
                                {t('directoriesCreated')}: {result.directoriesCreated}
                            </p>
                        )}
                        {result.directoriesUpdated > 0 && (
                            <p>
                                {t('directoriesUpdated')}: {result.directoriesUpdated}
                            </p>
                        )}
                        {result.directoriesSkipped > 0 && (
                            <p>
                                {t('directoriesSkipped')}: {result.directoriesSkipped}
                            </p>
                        )}
                        {result.userPluginsImported > 0 && (
                            <p>
                                {t('pluginsImported')}: {result.userPluginsImported}
                            </p>
                        )}
                    </div>
                </div>

                {result.warnings.length > 0 && (
                    <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
                        <h4 className="text-sm font-medium mb-1">{t('warnings')}</h4>
                        <ul className="list-disc list-inside text-xs space-y-1">
                            {result.warnings.map((w, i) => (
                                <li key={i}>{w}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {result.errors.length > 0 && (
                    <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                        <h4 className="text-sm font-medium mb-1">{t('errors')}</h4>
                        <ul className="list-disc list-inside text-xs space-y-1">
                            {result.errors.map((e, i) => (
                                <li key={i}>{e}</li>
                            ))}
                        </ul>
                    </div>
                )}

                <Button variant="ghost" onClick={onClose} size="sm">
                    {t('done')}
                </Button>
            </div>
        );
    }

    return null;
}
