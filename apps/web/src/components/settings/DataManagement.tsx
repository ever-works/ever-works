'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Download, Upload } from 'lucide-react';
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
        <div className="space-y-8">
            {/* Export Section */}
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('exportTitle')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('exportDescription')}
                </p>

                <div className="flex items-center gap-3 mb-4">
                    <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark cursor-pointer">
                        <input
                            type="checkbox"
                            checked={includeSecrets}
                            onChange={(e) => setIncludeSecrets(e.target.checked)}
                            className="rounded border-border dark:border-border-dark"
                        />
                        {t('includeSecrets')}
                    </label>
                </div>

                {includeSecrets && (
                    <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm text-warning-foreground">
                        {t('secretsWarning')}
                    </div>
                )}

                <Button onClick={handleExport} disabled={isExporting} size="sm">
                    <Download className="w-4 h-4" />
                    {isExporting ? t('exporting') : t('exportButton')}
                </Button>
            </div>

            <hr className="border-border dark:border-border-dark" />

            {/* Import Section */}
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('importTitle')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('importDescription')}
                </p>

                {!showImport ? (
                    <Button variant="secondary" onClick={() => setShowImport(true)} size="sm">
                        <Upload className="w-4 h-4" />
                        {t('importButton')}
                    </Button>
                ) : (
                    <ImportFlow onClose={() => setShowImport(false)} />
                )}
            </div>

            <hr className="border-border dark:border-border-dark" />

            {/* GitHub Sync Section */}
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('syncTitle')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('syncDescription')}
                </p>

                <GitHubSync />
            </div>
        </div>
    );
}
