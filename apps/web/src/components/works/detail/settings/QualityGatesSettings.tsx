'use client';

import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { TaskAcceptanceCheck, WorkChecksPolicy } from '@ever-works/contracts';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRouter } from '@/i18n/navigation';
import { updateQualityGatesSettings } from '@/app/actions/dashboard/works';
import { ChecksEditor } from '@/components/tasks/ChecksEditor';
import { useSettings } from './SettingsContext';

/**
 * Quality gates (Wave 3 M6) — Work-level acceptance-check defaults.
 *
 * `checkDefaults` are inherited by every agent-executed Task under this
 * Work (a Task's own checks override by id); `checksPolicy` decides
 * whether the gate runs and whether red blocks; `maxGateAttempts`
 * bounds the in-run iterate loop. Saves flow through the same
 * `PATCH /works/:id` UpdateWorkDto path as the sibling settings cards
 * (TaskIsolationSettings / CommitterSettings).
 */
export function QualityGatesSettings() {
    const t = useTranslations('dashboard.workDetail.settings.qualityGates');
    const { context } = useSettings();
    const { work } = context;
    const router = useRouter();

    const policy: WorkChecksPolicy = work.checksPolicy ?? 'off';
    const maxAttempts = work.maxGateAttempts ?? 2;

    const [defaults, setDefaults] = useState<TaskAcceptanceCheck[]>(
        (work.checkDefaults ?? []).map((c) => ({ ...c })),
    );
    const [pendingField, setPendingField] = useState<'policy' | 'maxAttempts' | 'defaults' | null>(
        null,
    );
    const [, startTransition] = useTransition();

    const save = (
        field: 'policy' | 'maxAttempts' | 'defaults',
        settings: Parameters<typeof updateQualityGatesSettings>[1],
    ) => {
        setPendingField(field);
        startTransition(async () => {
            try {
                const result = await updateQualityGatesSettings(work.id, settings);
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
            data-testid="quality-gates-settings"
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
                {/* Enforcement policy */}
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-xs font-medium text-text dark:text-text-dark">
                            {t('policyLabel')}
                        </h4>
                        {pendingField === 'policy' && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
                        )}
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                        {t(`policyHint.${policy}`)}
                    </p>
                    <Select
                        value={policy}
                        onValueChange={(next) =>
                            save('policy', { checksPolicy: next as WorkChecksPolicy })
                        }
                        disabled={busy}
                        size="sm"
                        data-testid="quality-gates-policy"
                    >
                        <option value="off">{t('policyOff')}</option>
                        <option value="warn">{t('policyWarn')}</option>
                        <option value="required">{t('policyRequired')}</option>
                    </Select>
                </div>

                {/* Gate-attempt budget */}
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-xs font-medium text-text dark:text-text-dark">
                            {t('maxAttemptsLabel')}
                        </h4>
                        {pendingField === 'maxAttempts' && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
                        )}
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-2">
                        {t('maxAttemptsDescription')}
                    </p>
                    <Select
                        value={String(maxAttempts)}
                        onValueChange={(next) =>
                            save('maxAttempts', { maxGateAttempts: parseInt(next, 10) })
                        }
                        disabled={busy}
                        size="sm"
                        data-testid="quality-gates-max-attempts"
                    >
                        {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={String(n)}>
                                {n}
                            </option>
                        ))}
                    </Select>
                </div>

                {/* Default checks */}
                <div className="pt-2 border-t border-card-border dark:border-border-secondary-dark">
                    <h4 className="text-xs font-medium text-text dark:text-text-dark mb-1">
                        {t('defaultsLabel')}
                    </h4>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                        {t('defaultsDescription')}
                    </p>
                    <ChecksEditor
                        value={defaults}
                        onChange={setDefaults}
                        disabled={busy}
                        testIdPrefix="quality-gates-defaults"
                    />
                    <div className="mt-3 flex justify-end">
                        <Button
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                                const rows = defaults.filter(
                                    (c) => c.command.trim().length > 0 || c.disabled,
                                );
                                save('defaults', {
                                    checkDefaults: rows.length > 0 ? rows : null,
                                });
                            }}
                            data-testid="quality-gates-defaults-save"
                        >
                            {pendingField === 'defaults' ? '…' : t('defaultsSave')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
