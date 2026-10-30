'use client';

import { useEffect, useState, useTransition } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    isRepoDeclaredCommandAllowed,
    normalizeRepoDeclaredCommand,
    normalizeWorkRepoDeclaredCommandPolicy,
    WORK_REPO_DECLARED_COMMAND_MAX_ALLOW,
    type WorkRepoDeclaredCommandPolicy,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRouter } from '@/i18n/navigation';
import { getAppSpecChecksAction, type AppSpecCheckRow } from '@/app/actions/dashboard/app-spec';
import { updateRepoDeclaredCommands } from '@/app/actions/dashboard/works';

/**
 * APW-08 T14 (FR-14, ACC-08-10) — the App checks review surface.
 *
 * An App spec check is a command one of the owner's own machines runs, so on a
 * Fleet node it runs only once the owner has admitted that EXACT command
 * (EW-807's allow-list, `Work.repoDeclaredCommands`). Until then the run reports
 * it **Not admitted** and the gate is never green because of it. This card lists
 * the App spec's checks with that state and, per check, **Admit for my
 * machines**, which appends the command — normalized exactly as the Fleet
 * planner compares it — to the allow-list through the ordinary
 * `PATCH /api/works/:id`. Turning the allow-list on (`mode: 'allowlist'`) is part
 * of admitting: an owner who admits a command is asking for it to run.
 *
 * Nothing here removes an admission or edits a command: the allow-list stays the
 * EW-807 contract, and this card only ever adds the one command a row shows.
 *
 * Mounted by `QualityGatesSettings` for `kind === 'app'` only.
 */
export interface AppChecksAdmissionCardProps {
    workId: string;
    /** The Work's `repoDeclaredCommands` column, as the Work read returned it. */
    policy: WorkRepoDeclaredCommandPolicy | null | undefined;
}

export function AppChecksAdmissionCard({ workId, policy }: AppChecksAdmissionCardProps) {
    const t = useTranslations('dashboard.workDetail.settings.qualityGates.appChecks');
    const router = useRouter();
    const [checks, setChecks] = useState<AppSpecCheckRow[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    // Fail closed, like the planner: an unreadable column admits nothing.
    const [current, setCurrent] = useState<WorkRepoDeclaredCommandPolicy>(() =>
        normalizeWorkRepoDeclaredCommandPolicy(policy),
    );
    const [pendingCommand, setPendingCommand] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    useEffect(() => {
        setCurrent(normalizeWorkRepoDeclaredCommandPolicy(policy));
    }, [policy]);

    useEffect(() => {
        let cancelled = false;
        getAppSpecChecksAction(workId)
            .then((result) => {
                if (cancelled) return;
                if (result.success) setChecks(result.checks);
                else setLoadFailed(true);
            })
            .catch(() => {
                if (!cancelled) setLoadFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [workId]);

    const allowListFull = current.allow.length >= WORK_REPO_DECLARED_COMMAND_MAX_ALLOW;

    const admit = (command: string) => {
        const normalized = normalizeRepoDeclaredCommand(command);
        if (!normalized) return;
        const next: WorkRepoDeclaredCommandPolicy = {
            mode: 'allowlist',
            allow: current.allow.includes(normalized) ? current.allow : [...current.allow, normalized],
        };
        setPendingCommand(normalized);
        startTransition(async () => {
            try {
                const result = await updateRepoDeclaredCommands(workId, next);
                if (result.success) {
                    setCurrent(next);
                    toast.success(t('admitSaved'));
                    router.refresh();
                } else {
                    toast.error(t('admitFailed'));
                }
            } catch {
                toast.error(t('admitFailed'));
            } finally {
                setPendingCommand(null);
            }
        });
    };

    return (
        <div
            // APW-08 T11 (lane L8, PR #3036) — the checks-change notification links to
            // `/works/<id>/settings#app-checks`; this anchor is where it lands.
            id="app-checks"
            className="pt-2 border-t border-card-border dark:border-border-secondary-dark"
            data-testid="app-checks-admission-card"
        >
            <h4 className="text-xs font-medium text-text dark:text-text-dark mb-1">{t('title')}</h4>
            <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">{t('subtitle')}</p>

            {checks === null && !loadFailed && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('loading')}
                </p>
            )}
            {loadFailed && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark" role="status">
                    {t('loadFailed')}
                </p>
            )}
            {checks !== null && checks.length === 0 && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
            )}

            {checks !== null && checks.length > 0 && (
                <ul className="space-y-2" data-testid="app-checks-admission-rows">
                    {checks.map((check, index) => {
                        const command = normalizeRepoDeclaredCommand(check.command) ?? check.command;
                        const admitted = isRepoDeclaredCommandAllowed(command, current);
                        const busy = pendingCommand === command;
                        return (
                            <li
                                key={`${index}-${check.name}`}
                                className={cn(
                                    'rounded-md border px-3 py-2',
                                    'border-card-border dark:border-border-secondary-dark',
                                )}
                                data-testid={`app-check-row-${index}`}
                                data-admitted={admitted ? 'true' : 'false'}
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs font-medium text-text dark:text-text-dark">
                                        {check.name}
                                    </span>
                                    <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                        {check.required ? t('required') : t('advisory')}
                                    </span>
                                    <span
                                        className={cn(
                                            'ml-auto inline-flex items-center gap-1 text-[11px]',
                                            admitted
                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                : 'text-amber-600 dark:text-amber-400',
                                        )}
                                    >
                                        {admitted ? (
                                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                                        ) : (
                                            <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                                        )}
                                        {admitted ? t('admitted') : t('notAdmitted')}
                                    </span>
                                </div>
                                {/* Untrusted repository text: a text node, never markup. */}
                                <code className="mt-1 block break-all text-[11px] text-text-muted dark:text-text-muted-dark">
                                    {command}
                                </code>
                                {!admitted && (
                                    <div className="mt-2 flex items-center justify-end gap-2">
                                        {allowListFull && (
                                            <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                                {t('allowListFull', {
                                                    max: WORK_REPO_DECLARED_COMMAND_MAX_ALLOW,
                                                })}
                                            </span>
                                        )}
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={pendingCommand !== null || allowListFull}
                                            onClick={() => admit(command)}
                                            data-testid={`app-check-admit-${index}`}
                                        >
                                            {busy ? '…' : t('admit')}
                                        </Button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
