'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Clock, ExternalLink, Globe2, Loader2, Save } from 'lucide-react';

import type { Work } from '@/lib/api';
import type { SubdomainState } from '@/lib/api/plugins-capabilities/deploy';
import { getWorkSubdomain, setWorkSubdomain } from '@/app/actions/dashboard/deploy';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SubdomainManagementProps {
    work: Work;
}

/**
 * EW-740 — "Site URL / Subdomain" card on the Deploy tab.
 *
 * Surfaces the managed `*.ever.works` address that the platform allocates per
 * Work via `GET/PUT /api/deploy/works/:id/subdomain` (EW-739). The managed
 * subdomain is the **primary/default** address (per spec section 4.6), so this
 * card is rendered above `DomainManagement` and is always present for Works on
 * a managed-subdomain provider (`ever-works` / `k8s`). Custom domains remain
 * additive — this card does not duplicate or replace `DomainManagement`.
 *
 * Pattern follows `RuntimeEnvManagement` (PR #1319):
 *
 * - Cancellation guard + `.catch()` on the loader so a transport-level reject
 *   doesn't leave the spinner stuck forever.
 * - `loadError` gating — when the load fails we don't claim "Not allocated"
 *   (the server may actually have one set); instead we surface the error and
 *   disable Save so the user can't accidentally overwrite a value we never
 *   read.
 * - `editable=false` from the API → readonly mode (no Save button).
 */
export function SubdomainManagement({ work }: SubdomainManagementProps) {
    return <SubdomainManagementContent key={work.id} work={work} />;
}

function SubdomainManagementContent({ work }: SubdomainManagementProps) {
    const t = useTranslations('dashboard.workDetail.deploy.subdomain');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [state, setState] = useState<SubdomainState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [value, setValue] = useState('');

    useEffect(() => {
        let cancelled = false;
        getWorkSubdomain(work.id)
            .then((result) => {
                if (cancelled) return;
                if (result.success) {
                    setState(result.subdomain);
                    setLoadError(null);
                } else {
                    // Server-reported failure: leave `state` populated with a
                    // null payload so the spinner clears, but set `loadError`
                    // so the UI hides the misleading "not allocated" copy and
                    // disables Save.
                    setState(result.subdomain);
                    setLoadError(result.error ?? t('loadFailed'));
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setState({
                    subdomain: null,
                    fqdn: null,
                    url: null,
                    recordOk: false,
                    editable: false,
                });
                setLoadError(err instanceof Error ? err.message : t('loadFailed'));
            });
        return () => {
            cancelled = true;
        };
    }, [work.id, t]);

    const isLoading = state === null;
    const hasLoadError = loadError !== null;

    const handleSave = () => {
        const next = value.trim().toLowerCase();
        if (!next) return;
        startTransition(async () => {
            const result = await setWorkSubdomain(work.id, next);
            if (result.success) {
                setState(result.subdomain);
                setValue('');
                toast.success(t('saveSuccess'));
                router.refresh();
            } else {
                toast.error(result.error ?? t('saveFailed'));
            }
        });
    };

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        'bg-primary/10 dark:bg-primary-dark/10',
                    )}
                >
                    <Globe2 className="w-5 h-5 text-primary dark:text-primary-dark" />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h3>
                    <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                        {t('description')}
                    </p>

                    {isLoading ? (
                        <div className="flex items-center gap-2 text-text-secondary dark:text-text-secondary-dark text-sm py-2">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {t('loading')}
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {hasLoadError && (
                                <p className="text-sm text-error dark:text-error-dark">
                                    {loadError}
                                </p>
                            )}

                            <div>
                                <div className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                                    {t('currentLabel')}
                                </div>
                                {state?.fqdn && state.url ? (
                                    <div className="flex flex-wrap items-center gap-2">
                                        {state.recordOk ? (
                                            <a
                                                href={state.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1.5 font-mono text-sm text-primary dark:text-primary-dark hover:underline break-all"
                                            >
                                                {state.fqdn}
                                                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                                                <span className="sr-only">
                                                    {t('openLink', { url: state.url })}
                                                </span>
                                            </a>
                                        ) : (
                                            <span className="font-mono text-sm text-text dark:text-text-dark break-all">
                                                {state.fqdn}
                                            </span>
                                        )}
                                        {state.recordOk ? (
                                            <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-success/10 dark:bg-success-dark/10 text-success dark:text-success-dark">
                                                <CheckCircle2 className="w-3 h-3" />
                                                {t('liveBadge')}
                                            </span>
                                        ) : (
                                            <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-warning/10 dark:bg-warning-dark/10 text-warning dark:text-warning-dark">
                                                <Clock className="w-3 h-3" />
                                                {t('pendingDnsBadge')}
                                            </span>
                                        )}
                                    </div>
                                ) : hasLoadError ? (
                                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {t('loadFailedHint')}
                                    </p>
                                ) : (
                                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {t('notAllocated')}
                                    </p>
                                )}
                            </div>

                            {state?.editable && !hasLoadError ? (
                                <div>
                                    <label
                                        htmlFor={`subdomain-input-${work.id}`}
                                        className="mb-1 block text-xs font-medium text-text-secondary dark:text-text-secondary-dark"
                                    >
                                        {t('editLabel')}
                                    </label>
                                    <div className="flex gap-2">
                                        <div className="flex-1 flex items-center gap-1">
                                            <Input
                                                id={`subdomain-input-${work.id}`}
                                                value={value}
                                                onChange={(e) =>
                                                    setValue(e.target.value.toLowerCase())
                                                }
                                                placeholder={state.subdomain ?? t('placeholder')}
                                                variant="form"
                                                disabled={isPending}
                                                autoComplete="off"
                                                spellCheck={false}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleSave();
                                                    }
                                                }}
                                                className="font-mono"
                                            />
                                            <span className="shrink-0 font-mono text-sm text-text-secondary dark:text-text-secondary-dark">
                                                {t('helperSuffix')}
                                            </span>
                                        </div>
                                        <Button
                                            onClick={handleSave}
                                            disabled={isPending || !value.trim()}
                                            size="lg"
                                        >
                                            {isPending ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Save className="w-4 h-4" />
                                            )}
                                            <span className="ml-1">{t('saveButton')}</span>
                                        </Button>
                                    </div>
                                    <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {t('invalidFormat')}
                                    </p>
                                </div>
                            ) : !state?.editable && state?.subdomain ? (
                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {t('readonlyHint')}
                                </p>
                            ) : null}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
