'use client';

import { useState, useTransition } from 'react';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { Loader2 } from 'lucide-react';
import { updateTaskIsolationSettings } from '@/app/actions/dashboard/works';
import { useRouter } from '@/i18n/navigation';
import { toast } from 'sonner';

/**
 * Wave 2 M7 — Work-level worktree-per-Task isolation settings.
 *
 * Off (the default) means agents work directly against the Work's
 * repos; 'worktree' gives every isolated Task its own branch forked
 * from the base branch. Saves flow through the same
 * `PATCH /works/:id` UpdateWorkDto path as the sibling settings cards
 * (CommunityPrSettings / CommitterSettings).
 */
export function TaskIsolationSettings() {
    const t = useTranslations('dashboard.workDetail.settings.taskIsolation');
    const { context } = useSettings();
    const { work } = context;
    const router = useRouter();

    const enabled = (work.taskIsolation ?? 'off') === 'worktree';
    const targetRepo = work.taskIsolationTargetRepo ?? 'work-output';
    const cleanup = work.taskBranchCleanup ?? 'on-merge';

    const [baseBranch, setBaseBranch] = useState(work.taskIsolationBaseBranch ?? '');
    const [pendingField, setPendingField] = useState<
        'enabled' | 'baseBranch' | 'targetRepo' | 'cleanup' | null
    >(null);
    const [, startTransition] = useTransition();

    const save = (
        field: 'enabled' | 'baseBranch' | 'targetRepo' | 'cleanup',
        settings: Parameters<typeof updateTaskIsolationSettings>[1],
    ) => {
        setPendingField(field);
        startTransition(async () => {
            try {
                const result = await updateTaskIsolationSettings(work.id, settings);
                if (result.success) {
                    toast.success(t('saved'));
                    router.refresh();
                } else {
                    toast.error(result.error || t('saveFailed'));
                }
            } catch {
                toast.error(t('saveFailed'));
            } finally {
                setPendingField(null);
            }
        });
    };

    const busy = pendingField !== null;

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
            </div>

            <div className="px-5 py-4 space-y-4">
                {/* On/off toggle — maps to taskIsolation 'worktree'/'off'. */}
                <div className="flex items-center justify-between">
                    <div>
                        <h4 className="text-xs font-medium text-text dark:text-text-dark">
                            {t('enableLabel')}
                        </h4>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('enableDescription')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {pendingField === 'enabled' && (
                            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                        )}
                        <Switch
                            checked={enabled}
                            onChange={(next: boolean) =>
                                save('enabled', { taskIsolation: next ? 'worktree' : 'off' })
                            }
                            disabled={busy}
                            className="mt-0"
                            data-testid="task-isolation-toggle"
                        />
                    </div>
                </div>

                {enabled && (
                    <div className="space-y-4 pt-2 border-t border-card-border dark:border-border-secondary-dark">
                        {/* Base branch */}
                        <div>
                            <h4 className="text-xs font-medium text-text dark:text-text-dark">
                                {t('baseBranchLabel')}
                            </h4>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                                {t('baseBranchDescription')}
                            </p>
                            <div className="flex items-center gap-2">
                                <Input
                                    type="text"
                                    value={baseBranch}
                                    onChange={(e) => setBaseBranch(e.target.value)}
                                    placeholder={t('baseBranchPlaceholder')}
                                    variant="form"
                                    data-testid="task-isolation-base-branch"
                                />
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                        save('baseBranch', {
                                            taskIsolationBaseBranch: baseBranch.trim() || null,
                                        })
                                    }
                                    data-testid="task-isolation-base-branch-save"
                                >
                                    {pendingField === 'baseBranch' ? '…' : t('baseBranchSave')}
                                </Button>
                            </div>
                        </div>

                        {/* Target repo */}
                        <div>
                            <h4 className="text-xs font-medium text-text dark:text-text-dark mb-2">
                                {t('targetRepoLabel')}
                            </h4>
                            <Select
                                value={targetRepo}
                                onValueChange={(next) =>
                                    save('targetRepo', {
                                        taskIsolationTargetRepo: next as 'work-output' | 'linked',
                                    })
                                }
                                disabled={busy}
                                size="sm"
                                data-testid="task-isolation-target-repo"
                            >
                                <option value="work-output">{t('targetRepoWorkOutput')}</option>
                                <option value="linked" disabled>
                                    {t('targetRepoLinked')}
                                </option>
                            </Select>
                        </div>

                        {/* Branch cleanup */}
                        <div>
                            <h4 className="text-xs font-medium text-text dark:text-text-dark mb-2">
                                {t('cleanupLabel')}
                            </h4>
                            <Select
                                value={cleanup}
                                onValueChange={(next) =>
                                    save('cleanup', {
                                        taskBranchCleanup: next as 'on-merge' | 'manual',
                                    })
                                }
                                disabled={busy}
                                size="sm"
                                data-testid="task-isolation-cleanup"
                            >
                                <option value="on-merge">{t('cleanupOnMerge')}</option>
                                <option value="manual">{t('cleanupManual')}</option>
                            </Select>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
