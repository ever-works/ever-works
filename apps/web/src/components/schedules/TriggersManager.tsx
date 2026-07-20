'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Webhook, Plus, Pause, Play, RefreshCw, Trash2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    listInboundTriggersAction,
    createInboundTriggerAction,
    rotateInboundTriggerSecretAction,
    pauseInboundTriggerAction,
    resumeInboundTriggerAction,
    deleteInboundTriggerAction,
} from '@/app/actions/dashboard/inbound-triggers';
import type { InboundTriggerView, InboundTriggerWithSecret } from '@/lib/api/inbound-triggers';
import { ActivityTimestamp } from '@/components/activity-log/ActivityTimestamp';

/**
 * Inbound Triggers management — the write surface for the signed
 * webhook/API triggers that also appear read-only in the Schedules list.
 * Create returns the RAW signing secret exactly once; the reveal panel is
 * the only place it is ever shown, alongside the webhook URL and a
 * ready-to-run signed-curl recipe.
 */
export function TriggersManager() {
    const t = useTranslations('dashboard.triggers');
    const [triggers, setTriggers] = useState<InboundTriggerView[]>([]);
    const [loading, setLoading] = useState(true);
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [taskTitleTemplate, setTaskTitleTemplate] = useState('');
    // Explicit submit flag (house rule: not useTransition.pending for forms).
    const [isSubmitting, setIsSubmitting] = useState(false);
    // The id of the row with an in-flight pause/resume/rotate/delete.
    const [busyId, setBusyId] = useState<string | null>(null);
    // One-time secret reveal — cleared when the panel closes.
    const [reveal, setReveal] = useState<InboundTriggerWithSecret | null>(null);
    // window.location.origin is only known after mount (SSR has no window).
    const [origin, setOrigin] = useState('');

    useEffect(() => {
        setOrigin(window.location.origin);
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        const res = await listInboundTriggersAction();
        if (res.success) {
            setTriggers(res.data);
        } else {
            toast.error(res.error || t('toast.loadFailed'));
        }
        setLoading(false);
    }, [t]);

    useEffect(() => {
        void load();
    }, [load]);

    const resetForm = () => {
        setName('');
        setDescription('');
        setTaskTitleTemplate('');
    };

    const handleCreate = async () => {
        if (isSubmitting || name.trim().length === 0) return;
        setIsSubmitting(true);
        const res = await createInboundTriggerAction({
            name: name.trim(),
            description: description.trim() || undefined,
            taskTitleTemplate: taskTitleTemplate.trim() || undefined,
        });
        setIsSubmitting(false);
        if (res.success) {
            setTriggers((prev) => [res.data.trigger, ...prev]);
            setCreateOpen(false);
            resetForm();
            setReveal(res.data);
            toast.success(t('toast.created'));
        } else {
            toast.error(res.error || t('toast.createFailed'));
        }
    };

    const handleRotate = async (id: string) => {
        if (busyId) return;
        setBusyId(id);
        const res = await rotateInboundTriggerSecretAction(id);
        setBusyId(null);
        if (res.success) {
            setTriggers((prev) => prev.map((row) => (row.id === id ? res.data.trigger : row)));
            setReveal(res.data);
            toast.success(t('toast.rotated'));
        } else {
            toast.error(res.error || t('toast.rotateFailed'));
        }
    };

    const handleToggle = async (row: InboundTriggerView) => {
        if (busyId) return;
        setBusyId(row.id);
        const res =
            row.status === 'active'
                ? await pauseInboundTriggerAction(row.id)
                : await resumeInboundTriggerAction(row.id);
        setBusyId(null);
        if (res.success) {
            setTriggers((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
        } else {
            toast.error(res.error || t('toast.toggleFailed'));
        }
    };

    const handleDelete = async (id: string) => {
        if (busyId) return;
        // Destructive + irreversible (drops the trigger and its webhook URL) —
        // gate on an explicit confirm so a mis-tapped trash icon can't delete.
        if (!window.confirm(t('confirmDelete'))) return;
        setBusyId(id);
        const res = await deleteInboundTriggerAction(id);
        setBusyId(null);
        if (res.success) {
            setTriggers((prev) => prev.filter((r) => r.id !== id));
            toast.success(t('toast.deleted'));
        } else {
            toast.error(res.error || t('toast.deleteFailed'));
        }
    };

    return (
        <div className="mt-8">
            <div className="mb-4 flex items-center justify-between">
                <div>
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary dark:text-text-primary-dark">
                        <Webhook className="h-4 w-4" />
                        {t('title')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" />
                    {t('new')}
                </Button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-8 text-text-muted dark:text-text-muted-dark">
                    <Loader2 className="h-5 w-5 animate-spin" />
                </div>
            ) : triggers.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-text-muted dark:border-border-dark dark:text-text-muted-dark">
                    {t('empty')}
                </p>
            ) : (
                <ul className="space-y-2">
                    {triggers.map((row) => {
                        const busy = busyId === row.id;
                        return (
                            <li
                                key={row.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 dark:border-border-dark dark:bg-surface-dark"
                            >
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                            {row.name}
                                        </span>
                                        <span
                                            className={`rounded-full px-2 py-0.5 text-xs ${
                                                row.status === 'active'
                                                    ? 'bg-success/10 text-success dark:bg-success/15'
                                                    : 'bg-warning/10 text-warning dark:bg-warning/15'
                                            }`}
                                        >
                                            {t(`status.${row.status}`)}
                                        </span>
                                    </div>
                                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('firedCount', { count: row.fireCount })}
                                        {row.lastFiredAt ? (
                                            <>
                                                {' · '}
                                                {t('lastFired')}{' '}
                                                <ActivityTimestamp value={row.lastFiredAt} />
                                            </>
                                        ) : null}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={busyId !== null}
                                        aria-label={
                                            row.status === 'active'
                                                ? t('actions.pause')
                                                : t('actions.resume')
                                        }
                                        title={
                                            row.status === 'active'
                                                ? t('actions.pause')
                                                : t('actions.resume')
                                        }
                                        onClick={() => handleToggle(row)}
                                    >
                                        {row.status === 'active' ? (
                                            <Pause className="h-4 w-4" />
                                        ) : (
                                            <Play className="h-4 w-4" />
                                        )}
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={busyId !== null}
                                        aria-label={t('actions.rotate')}
                                        title={t('actions.rotate')}
                                        onClick={() => handleRotate(row.id)}
                                    >
                                        <RefreshCw
                                            className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`}
                                        />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={busyId !== null}
                                        aria-label={t('actions.delete')}
                                        title={t('actions.delete')}
                                        onClick={() => handleDelete(row.id)}
                                    >
                                        <Trash2 className="h-4 w-4 text-danger" />
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent>
                    <DialogHeader>
                        <h2 className="text-lg font-semibold text-text-primary dark:text-text-primary-dark">
                            {t('createTitle')}
                        </h2>
                        <DialogDescription>{t('createDescription')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.name')}
                            </label>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                maxLength={120}
                                placeholder={t('form.namePlaceholder')}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.description')}
                            </label>
                            <Textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                maxLength={2000}
                                rows={2}
                                placeholder={t('form.descriptionPlaceholder')}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.taskTitle')}
                            </label>
                            <Input
                                value={taskTitleTemplate}
                                onChange={(e) => setTaskTitleTemplate(e.target.value)}
                                maxLength={200}
                                placeholder={t('form.taskTitlePlaceholder')}
                            />
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('form.taskTitleHint')}
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="secondary"
                            onClick={() => setCreateOpen(false)}
                            disabled={isSubmitting}
                        >
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={isSubmitting || name.trim().length === 0}
                        >
                            {isSubmitting ? (
                                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            ) : null}
                            {t('actions.create')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <SecretReveal reveal={reveal} origin={origin} onClose={() => setReveal(null)} />
        </div>
    );
}

interface SecretRevealProps {
    reveal: InboundTriggerWithSecret | null;
    origin: string;
    onClose: () => void;
}

function SecretReveal({ reveal, origin, onClose }: SecretRevealProps) {
    const t = useTranslations('dashboard.triggers');
    const [copied, setCopied] = useState<string | null>(null);

    if (!reveal) return null;

    const url = `${origin}/api/inbound-triggers/${reveal.trigger.id}/fire`;
    // A ready-to-run signed request. The recipe mirrors the server's
    // verification exactly: hex HMAC-SHA256 over `${timestamp}.${body}`.
    const curl = [
        'TS=$(date +%s)',
        `BODY='{\"hello\":\"world\"}'`,
        `SIG=$(printf '%s.%s' \"$TS\" \"$BODY\" | openssl dgst -sha256 -hmac '${reveal.secret}' | awk '{print $2}')`,
        `curl -X POST '${url}' \\`,
        '  -H "content-type: application/json" \\',
        '  -H "x-everworks-timestamp: $TS" \\',
        '  -H "x-everworks-signature: $SIG" \\',
        '  -d "$BODY"',
    ].join('\n');

    const copy = async (value: string, key: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(key);
            setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
        } catch {
            toast.error(t('toast.copyFailed'));
        }
    };

    return (
        <Dialog open={reveal !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent>
                <DialogHeader>
                    <h2 className="text-lg font-semibold text-text-primary dark:text-text-primary-dark">
                        {t('reveal.title')}
                    </h2>
                    <DialogDescription>{t('reveal.warning')}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <div>
                        <label className="mb-1 block text-xs font-medium uppercase text-text-muted dark:text-text-muted-dark">
                            {t('reveal.url')}
                        </label>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 truncate rounded bg-surface-secondary px-2 py-1.5 text-xs dark:bg-surface-secondary-dark">
                                {url}
                            </code>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t('reveal.copy')}
                                onClick={() => copy(url, 'url')}
                            >
                                {copied === 'url' ? (
                                    <Check className="h-4 w-4 text-success" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium uppercase text-text-muted dark:text-text-muted-dark">
                            {t('reveal.secret')}
                        </label>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 truncate rounded bg-surface-secondary px-2 py-1.5 text-xs dark:bg-surface-secondary-dark">
                                {reveal.secret}
                            </code>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t('reveal.copy')}
                                onClick={() => copy(reveal.secret, 'secret')}
                            >
                                {copied === 'secret' ? (
                                    <Check className="h-4 w-4 text-success" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium uppercase text-text-muted dark:text-text-muted-dark">
                            {t('reveal.curl')}
                        </label>
                        <div className="relative">
                            <pre className="overflow-x-auto rounded bg-surface-secondary p-3 text-xs dark:bg-surface-secondary-dark">
                                {curl}
                            </pre>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t('reveal.copy')}
                                className="absolute right-1 top-1"
                                onClick={() => copy(curl, 'curl')}
                            >
                                {copied === 'curl' ? (
                                    <Check className="h-4 w-4 text-success" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
                <DialogFooter>
                    <Button onClick={onClose}>{t('reveal.done')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
