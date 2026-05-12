'use client';

import { useEffect, useState, useTransition } from 'react';
import type { Work } from '@/lib/api';
import type { DeploymentDomain } from '@/lib/api/plugins-capabilities/deploy';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import {
    getDomains,
    addDomain as addDomainAction,
    removeDomain as removeDomainAction,
    verifyDomain as verifyDomainAction,
} from '@/app/actions/dashboard/deploy';
import {
    Globe,
    Plus,
    Trash2,
    CheckCircle2,
    Clock,
    ChevronDown,
    ChevronUp,
    Copy,
    RefreshCw,
    Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface DomainManagementProps {
    work: Work;
}

export function DomainManagement({ work }: DomainManagementProps) {
    return <DomainManagementContent key={work.id} work={work} />;
}

function DomainManagementContent({ work }: DomainManagementProps) {
    const t = useTranslations('dashboard.workDetail.deploy.domains');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [domains, setDomains] = useState<DeploymentDomain[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [newDomain, setNewDomain] = useState('');
    const [expandedDomain, setExpandedDomain] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        getDomains(work.id).then((result) => {
            if (cancelled) return;

            if (result.success) {
                setDomains(result.domains);
                setLoadError(null);
            } else {
                setDomains([]);
                setLoadError(result.error ?? t('loadFailed'));
            }
        });

        return () => {
            cancelled = true;
        };
    }, [work.id, t]);

    const isLoading = domains === null;
    const visibleDomains = domains ?? [];

    const handleAddDomain = () => {
        const domain = newDomain.trim();
        if (!domain) return;

        startTransition(async () => {
            const result = await addDomainAction(work.id, domain);
            if (result.success && result.domain) {
                setDomains((prev) => [...(prev ?? []), result.domain!]);
                setNewDomain('');
                if (result.verified) {
                    toast.success(t('addedAndVerified'));
                    router.refresh();
                } else {
                    toast.success(t('added'));
                    setExpandedDomain(result.domain.name);
                }
            } else {
                toast.error(result.error || t('addFailed'));
            }
        });
    };

    const handleRemoveDomain = (domain: string) => {
        startTransition(async () => {
            const result = await removeDomainAction(work.id, domain);
            if (result.success) {
                setDomains((prev) => (prev ?? []).filter((d) => d.name !== domain));
                toast.success(t('removed'));
                router.refresh();
            } else {
                toast.error(result.error || t('removeFailed'));
            }
        });
    };

    const handleVerifyDomain = (domain: string) => {
        startTransition(async () => {
            const result = await verifyDomainAction(work.id, domain);
            if (result.success && result.domain) {
                setDomains((prev) =>
                    (prev ?? []).map((d) => (d.name === domain ? result.domain! : d)),
                );
                if (result.domain.verified) {
                    toast.success(t('verified'));
                    router.refresh();
                } else {
                    toast.info(t('verifyPending'));
                }
            } else {
                toast.error(result.error || t('verifyFailed'));
            }
        });
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success(t('copied'));
    };

    // A `*.vercel.app` hostname is auto-managed by Vercel when the Work
    // deploys there — it can't be removed from the dashboard while the user
    // is still deploying to Vercel (Vercel re-creates it).
    //
    // BUT once the user has switched `deployProvider` away from Vercel, that
    // hostname is just a stale DB row pointing at a project the new provider
    // doesn't know about. The user needs to be able to clean it up.
    // (See EW-611.) The "no remove" gate therefore only applies while the
    // Work's current provider is still `vercel`.
    const isVercelAutoAssigned = (name: string) =>
        name.endsWith('.vercel.app') && work.deployProvider === 'vercel';

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        'bg-primary/10 dark:bg-primary-dark/10',
                    )}
                >
                    <Globe className="w-5 h-5 text-primary dark:text-primary-dark" />
                </div>
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h3>
                    <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                        {t('description')}
                    </p>

                    {/* Add domain form */}
                    <div className="flex gap-2 mb-4">
                        <div className="flex-1">
                            <Input
                                value={newDomain}
                                onChange={(e) => setNewDomain(e.target.value)}
                                placeholder={t('placeholder')}
                                variant="form"
                                disabled={isPending}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleAddDomain();
                                    }
                                }}
                            />
                        </div>
                        <Button
                            onClick={handleAddDomain}
                            disabled={isPending || !newDomain.trim()}
                            size="lg"
                        >
                            {isPending ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Plus className="w-4 h-4" />
                            )}
                            <span className="ml-1">{t('addButton')}</span>
                        </Button>
                    </div>

                    {/* Domain list */}
                    {isLoading ? (
                        <div className="flex items-center gap-2 text-text-secondary dark:text-text-secondary-dark text-sm py-4">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {t('loading')}
                        </div>
                    ) : loadError ? (
                        <p className="text-sm text-error dark:text-error-dark py-2">{loadError}</p>
                    ) : visibleDomains.length === 0 ? (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark py-2">
                            {t('noDomains')}
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {visibleDomains.map((domain) => (
                                <div
                                    key={domain.name}
                                    className="border border-border dark:border-border-dark rounded-lg"
                                >
                                    <div className="flex items-center justify-between p-3">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-sm text-text dark:text-text-dark font-medium truncate">
                                                {domain.name}
                                            </span>
                                            {isVercelAutoAssigned(domain.name) ? (
                                                <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                                                    {t('autoAssigned')}
                                                </span>
                                            ) : domain.verified ? (
                                                <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-success/10 dark:bg-success-dark/10 text-success dark:text-success-dark">
                                                    <CheckCircle2 className="w-3 h-3" />
                                                    {t('verifiedBadge')}
                                                </span>
                                            ) : (
                                                <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-warning/10 dark:bg-warning-dark/10 text-warning dark:text-warning-dark">
                                                    <Clock className="w-3 h-3" />
                                                    {t('pendingBadge')}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0 ml-2">
                                            {!domain.verified &&
                                                !isVercelAutoAssigned(domain.name) && (
                                                    <>
                                                        <button
                                                            onClick={() =>
                                                                handleVerifyDomain(domain.name)
                                                            }
                                                            disabled={isPending}
                                                            className="p-1.5 rounded-md text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                                            title={t('verifyButton')}
                                                        >
                                                            <RefreshCw
                                                                className={cn(
                                                                    'w-4 h-4',
                                                                    isPending && 'animate-spin',
                                                                )}
                                                            />
                                                        </button>
                                                        <button
                                                            onClick={() =>
                                                                setExpandedDomain(
                                                                    expandedDomain === domain.name
                                                                        ? null
                                                                        : domain.name,
                                                                )
                                                            }
                                                            className="p-1.5 rounded-md text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                                            title={t('dnsInstructions')}
                                                        >
                                                            {expandedDomain === domain.name ? (
                                                                <ChevronUp className="w-4 h-4" />
                                                            ) : (
                                                                <ChevronDown className="w-4 h-4" />
                                                            )}
                                                        </button>
                                                    </>
                                                )}
                                            {!isVercelAutoAssigned(domain.name) && (
                                                <button
                                                    onClick={() => handleRemoveDomain(domain.name)}
                                                    disabled={isPending}
                                                    className="p-1.5 rounded-md text-text-secondary dark:text-text-secondary-dark hover:text-error dark:hover:text-error-dark hover:bg-error/10 dark:hover:bg-error-dark/10 transition-colors"
                                                    title={t('removeButton')}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* DNS verification instructions */}
                                    {expandedDomain === domain.name &&
                                        !domain.verified &&
                                        domain.verification?.length && (
                                            <div className="border-t border-border dark:border-border-dark p-3 bg-surface-secondary/50 dark:bg-surface-secondary-dark/50 rounded-b-lg">
                                                <p className="text-sm font-medium text-text dark:text-text-dark mb-2">
                                                    {t('dnsTitle')}
                                                </p>
                                                <div className="space-y-2">
                                                    {domain.verification.map((v, i) => (
                                                        <div
                                                            key={i}
                                                            className="text-sm text-text-secondary dark:text-text-secondary-dark"
                                                        >
                                                            <div className="flex items-center gap-2 mb-1">
                                                                <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark">
                                                                    {v.type}
                                                                </span>
                                                                <span>{v.reason}</span>
                                                            </div>
                                                            <div className="grid grid-cols-[auto_1fr_auto] gap-2 items-center font-mono text-xs bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded p-2">
                                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                                    {t('dnsName')}
                                                                </span>
                                                                <span className="truncate">
                                                                    {v.domain}
                                                                </span>
                                                                <button
                                                                    onClick={() =>
                                                                        copyToClipboard(v.domain)
                                                                    }
                                                                    className="p-1 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark rounded"
                                                                    title={t('copyButton')}
                                                                >
                                                                    <Copy className="w-3 h-3" />
                                                                </button>
                                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                                    {t('dnsValue')}
                                                                </span>
                                                                <span className="truncate">
                                                                    {v.value}
                                                                </span>
                                                                <button
                                                                    onClick={() =>
                                                                        copyToClipboard(v.value)
                                                                    }
                                                                    className="p-1 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark rounded"
                                                                    title={t('copyButton')}
                                                                >
                                                                    <Copy className="w-3 h-3" />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
