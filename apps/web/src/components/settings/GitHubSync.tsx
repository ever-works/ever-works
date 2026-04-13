'use client';

import { useState, useEffect, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Github, Upload, Download, Trash2, Plus, Check, AlertTriangle } from 'lucide-react';
import {
    getSyncStatus,
    configureSyncRepo,
    pushToGitHub,
    pullFromGitHub,
    removeSyncConfig,
} from '@/app/actions/account-transfer';
import type { SyncStatus, ImportPreview } from '@/lib/api/account-transfer.types';
import { ImportFlow } from './ImportFlow';

export function GitHubSync() {
    const t = useTranslations('dashboard.settings.data.sync');
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [isPending, startTransition] = useTransition();
    const [repoName, setRepoName] = useState('');
    const [showConfigure, setShowConfigure] = useState(false);
    const [pullPreview, setPullPreview] = useState<ImportPreview | null>(null);
    const [showPullImport, setShowPullImport] = useState(false);
    const [includeSecrets, setIncludeSecrets] = useState(false);

    const loadStatus = () => {
        startTransition(() => {
            void (async () => {
                const result = await getSyncStatus();
                if (result.success && result.data) {
                    setStatus(result.data);
                }
            })();
        });
    };

    useEffect(() => {
        loadStatus();
    }, []);

    const handleCreateNew = () => {
        startTransition(() => {
            void (async () => {
                const result = await configureSyncRepo({ createNew: true });
                if (result.success && result.data) {
                    setStatus(result.data);
                    setShowConfigure(false);
                    toast.success(t('configureSuccess'));
                } else {
                    toast.error(result.error || t('configureError'));
                }
            })();
        });
    };

    const handleConnectExisting = () => {
        if (!repoName.trim() || !repoName.includes('/')) {
            toast.error(t('invalidRepoName'));
            return;
        }

        startTransition(() => {
            void (async () => {
                const result = await configureSyncRepo({ repoFullName: repoName.trim() });
                if (result.success && result.data) {
                    setStatus(result.data);
                    setShowConfigure(false);
                    setRepoName('');
                    toast.success(t('configureSuccess'));
                } else {
                    toast.error(result.error || t('configureError'));
                }
            })();
        });
    };

    const handlePush = () => {
        startTransition(() => {
            void (async () => {
                const result = await pushToGitHub({ includeSecrets });
                if (result.success) {
                    toast.success(t('pushSuccess'));
                    loadStatus();
                } else {
                    toast.error(result.error || t('pushError'));
                }
            })();
        });
    };

    const handlePull = () => {
        startTransition(() => {
            void (async () => {
                const result = await pullFromGitHub();
                if (result.success && result.data) {
                    setPullPreview(result.data);
                    setShowPullImport(true);
                } else {
                    toast.error(result.error || t('pullError'));
                }
            })();
        });
    };

    const handleDisconnect = () => {
        startTransition(() => {
            void (async () => {
                const result = await removeSyncConfig();
                if (result.success) {
                    setStatus({ configured: false, hasOAuth: status?.hasOAuth || false });
                    toast.success(t('disconnectSuccess'));
                } else {
                    toast.error(result.error || t('disconnectError'));
                }
            })();
        });
    };

    if (!status) {
        return (
            <div className="text-sm text-text-muted dark:text-text-muted-dark">{t('loading')}</div>
        );
    }

    if (!status.hasOAuth) {
        return (
            <div className="p-4 rounded-lg border border-border dark:border-border-dark">
                <div className="flex items-center gap-0.5 mb-2">
                    <Github className="w-5 h-5" />
                    <span className="font-medium text-text dark:text-text-dark">
                        {t('connectGitHub')}
                    </span>
                </div>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('connectGitHubDescription')}
                </p>
            </div>
        );
    }

    // Show pull import flow
    if (showPullImport && pullPreview) {
        return (
            <ImportFlow
                onClose={() => {
                    setShowPullImport(false);
                    setPullPreview(null);
                    loadStatus();
                }}
                initialPreview={pullPreview}
                isPullMode
            />
        );
    }

    if (!status.configured) {
        return (
            <div className="space-y-4">
                {!showConfigure ? (
                    <Button variant="secondary" onClick={() => setShowConfigure(true)} size="sm">
                        <Github className="w-4 h-4" />
                        {t('setupSync')}
                    </Button>
                ) : (
                    <div className="p-4 rounded-lg border border-border dark:border-border-dark space-y-4">
                        <div>
                            <Button
                                onClick={handleCreateNew}
                                disabled={isPending}
                                variant="secondary"
                                size="sm"
                                className="w-full justify-start"
                            >
                                <Plus className="w-4 h-4 mr-2" />
                                {t('createNewRepo')}
                            </Button>
                        </div>

                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-border dark:border-border-dark" />
                            </div>
                            <div className="relative flex justify-center text-xs">
                                <span className="bg-white dark:bg-gray-900 px-2 text-text-muted dark:text-text-muted-dark">
                                    {t('or')}
                                </span>
                            </div>
                        </div>

                        <div className="flex gap-2">
                            <Input
                                value={repoName}
                                onChange={(e) => setRepoName(e.target.value)}
                                placeholder={t('repoPlaceholder')}
                                className="flex-1"
                            />
                            <Button
                                onClick={handleConnectExisting}
                                disabled={isPending || !repoName.trim()}
                                variant="secondary"
                                size="sm"
                            >
                                {t('connect')}
                            </Button>
                        </div>

                        <Button variant="ghost" size="sm" onClick={() => setShowConfigure(false)}>
                            {t('cancel')}
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    // Connected state
    return (
        <div className="space-y-4">
            <div className="p-4 rounded-lg border border-border dark:border-border-dark">
                <div className="flex items-center gap-2 mb-3">
                    <Github className="w-5 h-5" />
                    <span className="font-medium text-text dark:text-text-dark">
                        {status.repoOwner}/{status.repoName}
                    </span>
                    <Check className="w-4 h-4 text-green-600" />
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm mb-4">
                    {status.lastPushAt && (
                        <>
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('lastPush')}:
                            </span>
                            <span className="text-text dark:text-text-dark">
                                {new Date(status.lastPushAt).toLocaleString()}
                            </span>
                        </>
                    )}
                    {status.lastPullAt && (
                        <>
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('lastPull')}:
                            </span>
                            <span className="text-text dark:text-text-dark">
                                {new Date(status.lastPullAt).toLocaleString()}
                            </span>
                        </>
                    )}
                </div>

                {status.lastSyncError && (
                    <div className="p-2 rounded bg-destructive/10 text-sm text-destructive mb-4 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <span>{status.lastSyncError}</span>
                    </div>
                )}

                <div className="flex items-center gap-2 mb-3">
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
                    <div className="mb-3 p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm text-warning-foreground">
                        {t('secretsWarning')}
                    </div>
                )}

                <div className="flex gap-2 flex-wrap">
                    <Button onClick={handlePush} disabled={isPending} size="sm">
                        <Upload className="w-4 h-4 mr-2" />
                        {t('push')}
                    </Button>
                    <Button onClick={handlePull} disabled={isPending} variant="secondary" size="sm">
                        <Download className="w-4 h-4 mr-2" />
                        {t('pull')}
                    </Button>
                    <Button
                        onClick={handleDisconnect}
                        disabled={isPending}
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                    >
                        <Trash2 className="w-4 h-4 mr-2" />
                        {t('disconnect')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
