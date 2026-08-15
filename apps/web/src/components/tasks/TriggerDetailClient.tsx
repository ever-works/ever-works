'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    Loader2,
    Pause,
    Play,
    RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    fireNowInboundTriggerAction,
    listInboundTriggerFiresAction,
    pauseInboundTriggerAction,
    resumeInboundTriggerAction,
    rotateInboundTriggerSecretAction,
} from '@/app/actions/dashboard/inbound-triggers';
import type {
    InboundTriggerFireStatus,
    InboundTriggerFireView,
    InboundTriggerView,
} from '@/lib/api/inbound-triggers';
import { ActivityTimestamp } from '@/components/activity-log/ActivityTimestamp';

interface TriggerDetailClientProps {
    trigger: InboundTriggerView;
    initialFires: InboundTriggerFireView[];
    /** Absolute origin of the API the webhook is delivered to. */
    apiBaseUrl: string;
}

const STATUS_CLASSES: Record<InboundTriggerFireStatus, string> = {
    running: 'bg-primary-500/10 text-primary-600 dark:text-primary-400',
    done: 'bg-success/10 text-success',
    failed: 'bg-danger/10 text-danger',
    refused: 'bg-warning/10 text-warning',
};

/**
 * Trigger detail — webhook management (URL, signed curl example, secret
 * rotation), the manual controls (Fire now, Pause/Resume) and the recent
 * fires log with its status chips.
 *
 * The signing secret is never readable after create, so the curl example
 * shows a `$TRIGGER_SECRET` placeholder rather than pretending to know
 * it; rotating reveals a fresh secret exactly once, right here.
 */
export function TriggerDetailClient({
    trigger: initialTrigger,
    initialFires,
    apiBaseUrl,
}: TriggerDetailClientProps) {
    const t = useTranslations('dashboard.taskTriggers.detail');
    const tShared = useTranslations('dashboard.taskTriggers');
    const [trigger, setTrigger] = useState<InboundTriggerView>(initialTrigger);
    const [fires, setFires] = useState<InboundTriggerFireView[]>(initialFires);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [curlOpen, setCurlOpen] = useState(false);
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

    const fireUrl = `${apiBaseUrl}/api/inbound-triggers/${trigger.id}/fire`;
    const curlExample = [
        'TS=$(date +%s)',
        `BODY='{"example":"payload"}'`,
        'SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$TRIGGER_SECRET" -r | cut -d" " -f1)',
        `curl -X POST '${fireUrl}' \\`,
        `  -H 'content-type: application/json' \\`,
        `  -H "x-everworks-timestamp: $TS" \\`,
        `  -H "x-everworks-signature: $SIG" \\`,
        `  -d "$BODY"`,
    ].join('\n');

    const copy = async (value: string, key: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(key);
            setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
        } catch {
            toast.error(t('copyFailed'));
        }
    };

    const refreshFires = async () => {
        const res = await listInboundTriggerFiresAction(trigger.id);
        if (res.success) setFires(res.data);
    };

    const handleFireNow = async () => {
        if (busy) return;
        setBusy(true);
        const res = await fireNowInboundTriggerAction(trigger.id);
        if (res.success) {
            setTrigger((prev) => ({
                ...prev,
                fireCount: prev.fireCount + 1,
                lastFiredAt: new Date().toISOString(),
            }));
            await refreshFires();
            toast.success(tShared('toast.fired', { title: res.data.taskTitle }));
        } else {
            toast.error(res.error || tShared('toast.fireFailed'));
        }
        setBusy(false);
    };

    const handleToggle = async () => {
        if (busy) return;
        setBusy(true);
        const res =
            trigger.status === 'active'
                ? await pauseInboundTriggerAction(trigger.id)
                : await resumeInboundTriggerAction(trigger.id);
        setBusy(false);
        if (res.success) {
            setTrigger(res.data);
        } else {
            toast.error(res.error || tShared('toast.toggleFailed'));
        }
    };

    const handleRotate = async () => {
        if (busy) return;
        if (!window.confirm(t('rotateConfirm'))) return;
        setBusy(true);
        const res = await rotateInboundTriggerSecretAction(trigger.id);
        setBusy(false);
        if (res.success) {
            setTrigger(res.data.trigger);
            setRevealedSecret(res.data.secret);
            toast.success(tShared('toast.rotated'));
        } else {
            toast.error(res.error || tShared('toast.rotateFailed'));
        }
    };

    return (
        <div className="space-y-6" data-testid="task-trigger-detail">
            <section className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    onClick={handleFireNow}
                    disabled={busy}
                    data-testid="trigger-fire-now"
                >
                    {busy ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                        <Play className="mr-1 h-4 w-4" />
                    )}
                    {t('fireNow')}
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleToggle}
                    disabled={busy}
                    data-testid="trigger-toggle"
                >
                    {trigger.status === 'active' ? (
                        <Pause className="mr-1 h-4 w-4" />
                    ) : (
                        <Play className="mr-1 h-4 w-4" />
                    )}
                    {trigger.status === 'active' ? t('pause') : t('resume')}
                </Button>
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('fireSummary', {
                        count: trigger.fireCount,
                        mode:
                            trigger.mode === 'template'
                                ? tShared('mode.template')
                                : tShared('mode.task'),
                    })}
                </span>
            </section>

            {trigger.sourceType === 'webhook' ? (
                <section
                    className="rounded-lg border border-border p-4 dark:border-border-dark"
                    data-testid="trigger-webhook-panel"
                >
                    <h2 className="mb-3 text-sm font-semibold text-text dark:text-text-dark">
                        {t('webhookTitle')}
                    </h2>
                    <label className="mb-1 block text-xs font-medium uppercase text-text-muted dark:text-text-muted-dark">
                        {t('webhookUrl')}
                    </label>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded bg-surface-secondary px-2 py-1.5 text-xs dark:bg-surface-secondary-dark">
                            {fireUrl}
                        </code>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('copy')}
                            onClick={() => copy(fireUrl, 'url')}
                            data-testid="trigger-copy-url"
                        >
                            {copied === 'url' ? (
                                <Check className="h-4 w-4 text-success" />
                            ) : (
                                <Copy className="h-4 w-4" />
                            )}
                        </Button>
                    </div>

                    <button
                        type="button"
                        onClick={() => setCurlOpen((open) => !open)}
                        className="mt-3 flex items-center gap-1 text-xs font-medium text-text-secondary dark:text-text-secondary-dark"
                        aria-expanded={curlOpen}
                        data-testid="trigger-curl-toggle"
                    >
                        {curlOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        {t('curlTitle')}
                    </button>
                    {curlOpen ? (
                        <div className="mt-2">
                            <pre className="overflow-x-auto rounded bg-surface-secondary p-3 text-xs dark:bg-surface-secondary-dark">
                                {curlExample}
                            </pre>
                            <div className="mt-2 flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => copy(curlExample, 'curl')}
                                >
                                    {copied === 'curl' ? (
                                        <Check className="mr-1 h-4 w-4 text-success" />
                                    ) : (
                                        <Copy className="mr-1 h-4 w-4" />
                                    )}
                                    {t('copyCurl')}
                                </Button>
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('curlHint', { window: trigger.replayWindowSec })}
                                </span>
                            </div>
                        </div>
                    ) : null}

                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 dark:border-border-dark">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={handleRotate}
                            disabled={busy}
                            data-testid="trigger-rotate-secret"
                        >
                            <RefreshCw className="mr-1 h-4 w-4" />
                            {t('rotate')}
                        </Button>
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('rotateHint')}
                        </span>
                    </div>
                    {revealedSecret ? (
                        <div
                            className="mt-3 rounded border border-warning/40 bg-warning/5 p-3"
                            data-testid="trigger-revealed-secret"
                        >
                            <p className="mb-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('secretWarning')}
                            </p>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 truncate rounded bg-surface-secondary px-2 py-1.5 text-xs dark:bg-surface-secondary-dark">
                                    {revealedSecret}
                                </code>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t('copy')}
                                    onClick={() => copy(revealedSecret, 'secret')}
                                >
                                    {copied === 'secret' ? (
                                        <Check className="h-4 w-4 text-success" />
                                    ) : (
                                        <Copy className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </section>
            ) : null}

            <section
                className="rounded-lg border border-border p-4 dark:border-border-dark"
                data-testid="trigger-recent-fires"
            >
                <h2 className="mb-3 text-sm font-semibold text-text dark:text-text-dark">
                    {t('recentFires')}
                </h2>
                {fires.length === 0 ? (
                    <p className="py-6 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        {t('noFires')}
                    </p>
                ) : (
                    <ul className="divide-y divide-border dark:divide-border-dark">
                        {fires.map((fire) => (
                            <li
                                key={fire.id}
                                className="flex flex-wrap items-center gap-2 py-2 text-xs"
                                data-testid={`trigger-fire-${fire.id}`}
                            >
                                <span
                                    className={`rounded-full px-2 py-0.5 ${STATUS_CLASSES[fire.status]}`}
                                >
                                    {t(`fireStatus.${fire.status}`)}
                                </span>
                                <span className="text-text-secondary dark:text-text-secondary-dark">
                                    {t(`fireOrigin.${fire.origin}`)}
                                </span>
                                <ActivityTimestamp value={fire.firedAt} />
                                {fire.reason ? (
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {fire.reason}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
