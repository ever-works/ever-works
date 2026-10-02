'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BarChart3, ExternalLink, RotateCcw, Send } from 'lucide-react';
import type {
    InstanceStatsOperatorStatus,
    InstanceStatsReportView,
    InstanceStatsStatus,
    WorksStatsV1Report,
} from '@ever-works/contracts';
import { isInstanceStatsOperatorStatus } from '@ever-works/contracts';
import {
    getInstanceStatsLastAction,
    getInstanceStatsStatusAction,
    previewInstanceStatsAction,
    resetInstanceStatsIdentityAction,
    sendInstanceStatsNowAction,
    setInstanceStatsEnabledAction,
    type InstanceStatsActionCode,
} from '@/app/actions/settings/instance-stats';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/** The public page that explains the report, the schema and how to verify it. */
export const USAGE_STATISTICS_DOCS_URL =
    'https://docs.ever.works/ever-platform/anonymous-statistics';

/** What a report can never contain — printed as a list, from the docs page's wording. */
const NEVER_INCLUDED = [
    'names',
    'emails',
    'addresses',
    'identifiers',
    'content',
    'amounts',
    'text',
    'location',
] as const;

interface UsageStatisticsSettingsProps {
    /** `off`: the API answered 404 — switched off by the installation's configuration. */
    state: 'loaded' | 'off' | 'unavailable';
    initialStatus: InstanceStatsStatus | null;
    initialLast: InstanceStatsReportView | null;
}

/**
 * Settings → Ever Platform → Anonymous usage statistics.
 *
 * The operator (the platform admin) sees the state and its reason, the next
 * send, *What is sent* (a live preview, never sent), *Last payload* (the exact
 * bytes that were posted, with the time and the answer), *Send now*, the
 * switch and *Reset instance identity*. Anyone else sees whether statistics
 * are on and who manages them. Every state is named in text, never by colour
 * alone.
 */
export function UsageStatisticsSettings({
    state,
    initialStatus,
    initialLast,
}: UsageStatisticsSettingsProps) {
    const t = useTranslations('dashboard.settings.everPlatform');
    const headingId = useId();

    return (
        <section
            className="space-y-6"
            aria-labelledby={headingId}
            data-testid="usage-statistics-settings"
        >
            <div>
                <h2
                    id={headingId}
                    className="text-xl font-semibold text-text dark:text-text-dark flex items-center gap-2"
                >
                    <BarChart3 className="w-5 h-5" aria-hidden="true" />
                    {t('statistics.title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1 max-w-3xl">
                    {t('statistics.description')}
                </p>
            </div>

            {state === 'off' && (
                <Notice testId="usage-statistics-env-off">
                    {t('statistics.offByConfiguration')}
                </Notice>
            )}
            {state === 'unavailable' && (
                <Notice testId="usage-statistics-unavailable">{t('statistics.unavailable')}</Notice>
            )}
            {state === 'loaded' &&
                initialStatus &&
                !isInstanceStatsOperatorStatus(initialStatus) && (
                    <Notice testId="usage-statistics-member">
                        {initialStatus.enabled
                            ? t('statistics.memberOn')
                            : t('statistics.memberOff')}{' '}
                        {t('statistics.managedByOperator')}
                    </Notice>
                )}
            {state === 'loaded' &&
                initialStatus &&
                isInstanceStatsOperatorStatus(initialStatus) && (
                    <OperatorView initialStatus={initialStatus} initialLast={initialLast} />
                )}

            <NeverIncluded />
        </section>
    );
}

function Notice({ children, testId }: { children: React.ReactNode; testId: string }) {
    return (
        <p
            className="text-sm text-text dark:text-text-dark p-4 rounded-lg border border-border dark:border-border-dark"
            data-testid={testId}
        >
            {children}
        </p>
    );
}

function NeverIncluded() {
    const t = useTranslations('dashboard.settings.everPlatform.statistics');
    return (
        <div className="p-4 rounded-lg border border-border dark:border-border-dark space-y-2">
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                {t('neverIncluded.title')}
            </h3>
            <ul className="list-disc pl-5 text-sm text-text-muted dark:text-text-muted-dark space-y-1">
                {NEVER_INCLUDED.map((key) => (
                    <li key={key}>{t(`neverIncluded.items.${key}`)}</li>
                ))}
            </ul>
            <a
                href={USAGE_STATISTICS_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
                {t('docsLink')}
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
        </div>
    );
}

function OperatorView({
    initialStatus,
    initialLast,
}: {
    initialStatus: InstanceStatsOperatorStatus;
    initialLast: InstanceStatsReportView | null;
}) {
    const t = useTranslations('dashboard.settings.everPlatform.statistics');
    const format = useFormatter();
    const [status, setStatus] = useState(initialStatus);
    const [last, setLast] = useState(initialLast);
    const [preview, setPreview] = useState<WorksStatsV1Report | null>(null);
    const [resetOpen, setResetOpen] = useState(false);
    const [isPending, startTransition] = useTransition();

    const fail = (code: InstanceStatsActionCode) => toast.error(t(`errors.${code}`));

    const refresh = async () => {
        const [nextStatus, nextLast] = await Promise.all([
            getInstanceStatsStatusAction(),
            getInstanceStatsLastAction(),
        ]);
        if (nextStatus.success && isInstanceStatsOperatorStatus(nextStatus.data))
            setStatus(nextStatus.data);
        if (nextLast.success) setLast(nextLast.data);
    };

    const toggle = (enabled: boolean) =>
        startTransition(async () => {
            const result = await setInstanceStatsEnabledAction(enabled);
            if (!result.success) return fail(result.code);
            toast.success(enabled ? t('toggle.turnedOn') : t('toggle.turnedOff'));
            await refresh();
        });

    const sendNow = () =>
        startTransition(async () => {
            const result = await sendInstanceStatsNowAction();
            if (!result.success) return fail(result.code);
            const first = result.data[0];
            if (first?.status === 'sent') toast.success(t('sendNow.sent'));
            else toast.error(t('sendNow.notSent', { status: first?.status ?? 'failed' }));
            await refresh();
        });

    const showPreview = () =>
        startTransition(async () => {
            const result = await previewInstanceStatsAction();
            if (!result.success) return fail(result.code);
            setPreview(result.data);
        });

    const resetIdentity = () =>
        startTransition(async () => {
            const result = await resetInstanceStatsIdentityAction();
            setResetOpen(false);
            if (!result.success) return fail(result.code);
            toast.success(t('reset.done'));
            await refresh();
        });

    const when = (iso: string | null) =>
        iso
            ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
            : t('notScheduled');
    const sendNowBlocked =
        !status.uiEnabled ||
        (status.sendNowAvailableAt !== null &&
            new Date(status.sendNowAvailableAt).getTime() > Date.now());

    return (
        <div className="space-y-6" data-testid="usage-statistics-operator">
            <div className="p-4 rounded-lg border border-border dark:border-border-dark space-y-4">
                <Switch
                    checked={status.uiEnabled}
                    onChange={toggle}
                    disabled={isPending}
                    label={t('toggle.label')}
                    helperText={t('toggle.helper')}
                    data-testid="usage-statistics-toggle"
                />
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <Fact label={t('facts.state')} testId="usage-statistics-reason">
                        {t(`reasons.${status.reason}`)}
                    </Fact>
                    <Fact label={t('facts.nextSend')}>{when(status.nextSendAt)}</Fact>
                    <Fact label={t('facts.installSource')}>{status.installSource}</Fact>
                    <Fact label={t('facts.country')}>{status.country}</Fact>
                    <Fact label={t('facts.endpoint')}>
                        <code className="break-all">{status.statsApiUrl}</code>
                    </Fact>
                    <Fact label={t('facts.instanceId')}>
                        <code className="break-all">{status.instanceId}</code>
                    </Fact>
                </dl>
                <div className="flex flex-wrap gap-2">
                    <Button
                        onClick={sendNow}
                        disabled={isPending || sendNowBlocked}
                        data-testid="usage-statistics-send-now"
                    >
                        <Send className="w-4 h-4" aria-hidden="true" />
                        {t('sendNow.button')}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={showPreview}
                        disabled={isPending}
                        data-testid="usage-statistics-preview"
                    >
                        {t('preview.button')}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => setResetOpen(true)}
                        disabled={isPending}
                        data-testid="usage-statistics-reset"
                    >
                        <RotateCcw className="w-4 h-4" aria-hidden="true" />
                        {t('reset.button')}
                    </Button>
                </div>
                {!status.uiEnabled && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('sendNow.disabledOff')}
                    </p>
                )}
            </div>

            {preview && (
                <Payload
                    title={t('preview.title')}
                    hint={t('preview.hint')}
                    body={JSON.stringify(preview, null, 2)}
                    testId="usage-statistics-preview-body"
                />
            )}

            <div className="space-y-2" data-testid="usage-statistics-last">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('last.title')}
                </h3>
                {last ? (
                    <>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('last.summary', {
                                when: when(last.attemptedAt),
                                status: t(`last.status.${last.status}`),
                                http: last.httpStatus ?? '—',
                                bytes: last.bytes,
                            })}
                            {last.errorCode ? ` ${t('last.error', { code: last.errorCode })}` : ''}
                        </p>
                        <Payload body={last.payload} testId="usage-statistics-last-body" />
                    </>
                ) : (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('last.none')}
                    </p>
                )}
            </div>

            <Dialog open={resetOpen} onOpenChange={(open) => !open && setResetOpen(false)}>
                <DialogContent>
                    <DialogClose onClose={() => setResetOpen(false)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('reset.confirmTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('reset.confirmBody')}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setResetOpen(false)}>
                            {t('reset.cancel')}
                        </Button>
                        <Button
                            onClick={resetIdentity}
                            loading={isPending}
                            data-testid="usage-statistics-reset-confirm"
                        >
                            {t('reset.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function Fact({
    label,
    children,
    testId,
}: {
    label: string;
    children: React.ReactNode;
    testId?: string;
}) {
    return (
        <div className="flex flex-col" data-testid={testId}>
            <dt className="text-xs text-text-muted dark:text-text-muted-dark">{label}</dt>
            <dd className="text-text dark:text-text-dark">{children}</dd>
        </div>
    );
}

function Payload({
    title,
    hint,
    body,
    testId,
}: {
    title?: string;
    hint?: string;
    body: string;
    testId: string;
}) {
    return (
        <div className="space-y-1">
            {title && (
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h3>
            )}
            {hint && <p className="text-xs text-text-muted dark:text-text-muted-dark">{hint}</p>}
            <pre
                className="text-xs p-3 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark overflow-x-auto max-h-96"
                data-testid={testId}
            >
                {body}
            </pre>
        </div>
    );
}
