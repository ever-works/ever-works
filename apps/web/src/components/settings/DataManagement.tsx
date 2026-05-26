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
    // Phase 19.6 — per-feature v2 payload tail toggles. All default
    // off so a v1 user gets a v1-shaped payload exactly as before.
    const [includeAgents, setIncludeAgents] = useState(false);
    const [includeSkills, setIncludeSkills] = useState(false);
    const [includeTasks, setIncludeTasks] = useState(false);
    const [includeTaskChat, setIncludeTaskChat] = useState(false);
    const [isExporting, startExportTransition] = useTransition();
    const [showImport, setShowImport] = useState(false);

    const handleExport = () => {
        startExportTransition(async () => {
            try {
                const result = await exportAccountData({
                    includeSecrets,
                    includeAgents,
                    includeSkills,
                    includeTasks,
                    includeTaskChat: includeTasks && includeTaskChat,
                });
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
        <div className="space-y-4">
            {/* Export Section */}
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <div className="flex items-start gap-3.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0">
                            <Download className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                                {t('exportTitle')}
                            </h2>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed mt-0.5">
                                {t('exportDescription')}
                            </p>
                        </div>
                    </div>

                    <div className="space-y-3 pl-11">
                        <label className="inline-flex items-center gap-2.5 cursor-pointer select-none group">
                            <input
                                type="checkbox"
                                checked={includeSecrets}
                                onChange={(e) => setIncludeSecrets(e.target.checked)}
                                className="rounded border-border dark:border-border-dark"
                            />
                            <span className="text-xs text-text-secondary dark:text-text-secondary-dark group-hover:text-text dark:group-hover:text-text-dark transition-colors">
                                {t('includeSecrets')}
                            </span>
                        </label>

                        {includeSecrets && (
                            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-warning/8 border border-warning/20 text-xs text-text-secondary dark:text-text-secondary-dark leading-relaxed">
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" />
                                <span>{t('secretsWarning')}</span>
                            </div>
                        )}

                        {/* Phase 19.6 — v2 payload tail: Agents / Skills /
                            Tasks (+ optional Task chat). All opt-in so a
                            v1 user gets the same payload they always did. */}
                        <fieldset className="space-y-2 pt-2 border-t border-border/40 dark:border-border-dark/40">
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
                                    Chat threads bloat the payload — only enable when you actually need them.
                                </p>
                            )}
                        </fieldset>

                        <div className="pt-1">
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
                    </div>
                </div>
            </div>

            {/* Import Section */}
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <div className="flex items-start gap-3.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0">
                            <Upload className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                                {t('importTitle')}
                            </h2>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed mt-0.5">
                                {t('importDescription')}
                            </p>
                        </div>
                    </div>

                    <div className="pl-11">
                        {!showImport ? (
                            <Button
                                variant="secondary"
                                onClick={() => setShowImport(true)}
                                size="sm"
                                className="h-8 px-3.5 text-xs font-medium gap-1.5 hover:shadow-sm active:scale-[0.97] transition-all duration-150"
                            >
                                <Upload className="w-3.5 h-3.5 stroke-[1.5]" />
                                {t('importButton')}
                            </Button>
                        ) : (
                            <ImportFlow onClose={() => setShowImport(false)} />
                        )}
                    </div>
                </div>
            </div>

            {/* GitHub Sync Section */}
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <div className="flex items-start gap-3.5 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 flex items-center justify-center shrink-0">
                            <Github className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                                {t('syncTitle')}
                            </h2>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed mt-0.5">
                                {t('syncDescription')}
                            </p>
                        </div>
                    </div>

                    <div className="pl-11">
                        <GitHubSync />
                    </div>
                </div>
            </div>
        </div>
    );
}
