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
    // FU-10 — v2 payload toggles. Same shape as DataManagement (export
    // form) so the user sees identical affordances across the two
    // surfaces. Each defaults off — pre-existing v1 syncs keep the
    // payload they always had until the user opts in.
    const [includeAgents, setIncludeAgents] = useState(false);
    const [includeSkills, setIncludeSkills] = useState(false);
    const [includeTasks, setIncludeTasks] = useState(false);
    const [includeTaskChat, setIncludeTaskChat] = useState(false);

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
                const result = await pushToGitHub({
                    includeSecrets,
                    includeAgents,
                    includeSkills,
                    includeTasks,
                    // Chat threads bloat the payload — gate on includeTasks too
                    // so toggling Tasks off doesn't leak the chat-only setting.
                    includeTaskChat: includeTasks && includeTaskChat,
                });
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
            <div className="flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark">
                <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 animate-bounce [animation-delay:300ms]" />
                </span>
                {t('loading')}
            </div>
        );
    }

    if (!status.hasOAuth) {
        return (
            <div className="p-5 rounded-xl border border-border dark:border-border-dark">
                <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0">
                        <Github className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <span className="font-medium text-sm text-text dark:text-text-dark">
                        {t('connectGitHub')}
                    </span>
                </div>
                <p className="text-sm text-text-muted dark:text-text-muted-dark leading-relaxed pl-11">
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
                    <Button
                        variant="secondary"
                        onClick={() => setShowConfigure(true)}
                        size="sm"
                        className="h-8 px-3.5 text-xs font-medium gap-1.5 hover:shadow-sm active:scale-[0.97] transition-all duration-150"
                    >
                        <Github className="w-3.5 h-3.5" />
                        {t('setupSync')}
                    </Button>
                ) : (
                    <div className="p-5 rounded-xl border border-border dark:border-border-dark space-y-4">
                        <Button
                            onClick={handleCreateNew}
                            disabled={isPending}
                            variant="secondary"
                            size="sm"
                            className="w-full justify-center h-9 text-xs font-medium gap-2 hover:shadow-sm active:scale-[0.98] transition-all duration-150"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            {t('createNewRepo')}
                        </Button>

                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-border dark:border-border-dark" />
                            </div>
                            <div className="relative flex justify-center text-xs">
                                <span className="bg-surface dark:bg-surface-dark px-2.5 text-text-muted dark:text-text-muted-dark">
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
                                className="h-9 px-3.5 font-medium hover:shadow-sm active:scale-[0.97] transition-all duration-150"
                            >
                                {t('connect')}
                            </Button>
                        </div>

                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowConfigure(false)}
                            className="h-8 px-3 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark active:scale-[0.97] transition-all duration-150"
                        >
                            {t('cancel')}
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    // Connected state
    return (
        <div className="rounded-xl border border-border dark:border-border-dark overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 flex items-center gap-3 border-b border-border/50 dark:border-border-dark/50">
                <div className="w-7 h-7 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border/50 dark:border-border-dark/50 flex items-center justify-center shrink-0">
                    <Github className="w-3.5 h-3.5 text-text dark:text-text-dark" />
                </div>
                <code className="flex-1 text-sm font-mono text-text dark:text-text-dark truncate">
                    {status.repoOwner}/{status.repoName}
                </code>
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 dark:bg-green-900/30 shrink-0">
                    <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
                </span>
            </div>

            {/* Timestamps */}
            {(status.lastPushAt || status.lastPullAt) && (
                <div className="px-5 py-3 border-b border-border/50 dark:border-border-dark/50 divide-y divide-border/30 dark:divide-border-dark/30">
                    {status.lastPushAt && (
                        <div className="flex items-center justify-between py-1.5 first:pt-0 last:pb-0 text-xs">
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('lastPush')}
                            </span>
                            <span className="text-text dark:text-text-dark font-medium tabular-nums">
                                {new Date(status.lastPushAt).toLocaleString()}
                            </span>
                        </div>
                    )}
                    {status.lastPullAt && (
                        <div className="flex items-center justify-between py-1.5 first:pt-0 last:pb-0 text-xs">
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('lastPull')}
                            </span>
                            <span className="text-text dark:text-text-dark font-medium tabular-nums">
                                {new Date(status.lastPullAt).toLocaleString()}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Error */}
            {status.lastSyncError && (
                <div className="px-5 py-3.5 border-b border-border/50 dark:border-border-dark/50">
                    <div className="flex items-start gap-2.5 text-sm text-destructive">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span className="leading-relaxed">{status.lastSyncError}</span>
                    </div>
                </div>
            )}

            {/* Options */}
            <div className="px-5 py-4 border-b border-border/50 dark:border-border-dark/50">
                <label className="inline-flex items-center gap-2.5 text-sm text-text dark:text-text-dark cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={includeSecrets}
                        onChange={(e) => setIncludeSecrets(e.target.checked)}
                        className="rounded border-border dark:border-border-dark"
                    />
                    {t('includeSecrets')}
                </label>

                {includeSecrets && (
                    <div className="mt-3 p-3.5 rounded-xl bg-warning/10 border border-warning/20 text-sm text-warning-foreground leading-relaxed flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
                        <span>{t('secretsWarning')}</span>
                    </div>
                )}

                {/* FU-10 — v2 payload tail toggles. Same affordances as
                    the local-export form in DataManagement.tsx so the
                    user encounters identical surfaces across export +
                    sync. */}
                <fieldset className="mt-4 pt-3 border-t border-border/40 dark:border-border-dark/40 space-y-1.5">
                    <legend className="text-[10px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark mb-1">
                        Additional sections (v2 payload)
                    </legend>
                    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none group">
                        <input
                            type="checkbox"
                            checked={includeAgents}
                            onChange={(e) => setIncludeAgents(e.target.checked)}
                            className="rounded border-border dark:border-border-dark"
                        />
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark group-hover:text-text dark:group-hover:text-text-dark transition-colors">
                            Include Agents
                        </span>
                    </label>
                    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none group ml-3">
                        <input
                            type="checkbox"
                            checked={includeSkills}
                            onChange={(e) => setIncludeSkills(e.target.checked)}
                            className="rounded border-border dark:border-border-dark"
                        />
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark group-hover:text-text dark:group-hover:text-text-dark transition-colors">
                            Include Skills (+ bindings)
                        </span>
                    </label>
                    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none group ml-3">
                        <input
                            type="checkbox"
                            checked={includeTasks}
                            onChange={(e) => {
                                setIncludeTasks(e.target.checked);
                                if (!e.target.checked) setIncludeTaskChat(false);
                            }}
                            className="rounded border-border dark:border-border-dark"
                        />
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark group-hover:text-text dark:group-hover:text-text-dark transition-colors">
                            Include Tasks
                        </span>
                    </label>
                    <label
                        className={`inline-flex items-center gap-2.5 select-none group ml-8 ${
                            includeTasks ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                        }`}
                    >
                        <input
                            type="checkbox"
                            checked={includeTasks && includeTaskChat}
                            disabled={!includeTasks}
                            onChange={(e) => setIncludeTaskChat(e.target.checked)}
                            className="rounded border-border dark:border-border-dark"
                        />
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark group-hover:text-text dark:group-hover:text-text-dark transition-colors">
                            Include Task chat threads
                        </span>
                    </label>
                    {includeTaskChat && includeTasks && (
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark pl-8 leading-relaxed">
                            Chat threads bloat the payload — only enable when you actually need
                            them.
                        </p>
                    )}
                </fieldset>
            </div>

            {/* Actions */}
            <div className="px-5 py-4 flex items-center gap-2 flex-wrap">
                <Button
                    onClick={handlePush}
                    disabled={isPending}
                    size="sm"
                    className="h-8 px-3.5 font-medium gap-1.5 shadow-sm hover:shadow active:scale-[0.97] transition-all duration-150"
                >
                    <Upload className="w-3.5 h-3.5" />
                    {t('push')}
                </Button>
                <Button
                    onClick={handlePull}
                    disabled={isPending}
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3.5 font-medium gap-1.5 hover:shadow-sm active:scale-[0.97] transition-all duration-150"
                >
                    <Download className="w-3.5 h-3.5" />
                    {t('pull')}
                </Button>
                <Button
                    onClick={handleDisconnect}
                    disabled={isPending}
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5 active:scale-[0.97] transition-all duration-150 ml-auto"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('disconnect')}
                </Button>
            </div>
        </div>
    );
}
