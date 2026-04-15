'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Download, Upload, Github, AlertTriangle } from 'lucide-react';
import { ImportFlow } from './ImportFlow';
import { GitHubSync } from './GitHubSync';
import { exportAccountData } from '@/app/actions/account-transfer';

export function DataManagement() {
    const t = useTranslations('dashboard.settings.data');
    const [includeSecrets, setIncludeSecrets] = useState(false);
    const [isExporting, startExportTransition] = useTransition();
    const [showImport, setShowImport] = useState(false);

    const handleExport = () => {
        startExportTransition(async () => {
            try {
                const result = await exportAccountData(includeSecrets);
                if (!result.success || !result.data) {
                    throw new Error(result.error || 'Export failed');
                }

                const blob = new Blob([JSON.stringify(result.data, null, 2)], {
                    type: 'application/json',
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `ever-works-export-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                toast.success(t('exportSuccess'));
            } catch (error) {
                toast.error(t('exportError'));
            }
        });
    };

    return (
        <div className="space-y-10">
            {/* Export Section */}
            <div className="space-y-4">
                <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-xl bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0 mt-0.5">
                        <Download className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold leading-tight tracking-tight text-text dark:text-text-dark mb-1">
                            {t('exportTitle')}
                        </h2>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark leading-relaxed">
                            {t('exportDescription')}
                        </p>
                    </div>
                </div>

                <label className="inline-flex items-center gap-2.5 text-sm text-text dark:text-text-dark cursor-pointer select-none px-3.5 py-2.5 rounded-xl border border-border/60 dark:border-border-dark/60 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors duration-150">
                    <input
                        type="checkbox"
                        checked={includeSecrets}
                        onChange={(e) => setIncludeSecrets(e.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {t('includeSecrets')}
                </label>

                {includeSecrets && (
                    <div className="p-3.5 rounded-xl bg-warning/10 border border-warning/20 text-sm text-warning-foreground leading-relaxed flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
                        <span>{t('secretsWarning')}</span>
                    </div>
                )}

                <Button
                    onClick={handleExport}
                    disabled={isExporting}
                    size="sm"
                    className="h-8 px-3.5 text-xs font-medium gap-1.5 shadow-sm hover:shadow active:scale-[0.97] transition-all duration-150"
                >
                    <Download className="w-3.5 h-3.5" />
                    {isExporting ? t('exporting') : t('exportButton')}
                </Button>
            </div>

            <div className="border-t border-dashed border-border/40 dark:border-border-dark/40" />

            {/* Import Section */}
            <div className="space-y-4">
                <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-xl bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0 mt-0.5">
                        <Upload className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold leading-tight tracking-tight text-text dark:text-text-dark mb-1">
                            {t('importTitle')}
                        </h2>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark leading-relaxed">
                            {t('importDescription')}
                        </p>
                    </div>
                </div>

                {!showImport ? (
                    <Button
                        variant="secondary"
                        onClick={() => setShowImport(true)}
                        size="sm"
                        className="h-8 px-3.5 text-xs font-medium gap-1.5 hover:shadow-sm active:scale-[0.97] transition-all duration-150"
                    >
                        <Upload className="w-3.5 h-3.5" />
                        {t('importButton')}
                    </Button>
                ) : (
                    <ImportFlow onClose={() => setShowImport(false)} />
                )}
            </div>

            <div className="border-t border-dashed border-border/40 dark:border-border-dark/40" />

            {/* GitHub Sync Section */}
            <div className="space-y-4">
                <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-xl bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0 mt-0.5">
                        <Github className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold leading-tight tracking-tight text-text dark:text-text-dark mb-1">
                            {t('syncTitle')}
                        </h2>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark leading-relaxed">
                            {t('syncDescription')}
                        </p>
                    </div>
                </div>

                <GitHubSync />
            </div>
        </div>
    );
}
