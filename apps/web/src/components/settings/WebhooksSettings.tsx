'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { DOMAIN_EVENT_TYPES } from '@ever-works/contracts';
import type { TeamsOrganization } from '@/lib/api/teams';
import type { WebhookDelivery, WebhookSubscription } from '@/lib/api/webhooks';
import {
    createWebhook,
    deleteWebhook,
    listWebhookDeliveries,
    listWebhooks,
    redeliverWebhook,
    rotateWebhookSecret,
    testWebhook,
    updateWebhook,
} from '@/app/actions/webhooks';

interface Props {
    initialSubscriptions: WebhookSubscription[];
    organizations: TeamsOrganization[];
    /** The server could not read the subscriptions (shown as an error, not as "none"). */
    loadFailed?: boolean;
}

/** The opt-in type a `<prefix>.*` pattern never includes (delivered only when named). */
const RUNTIME_TYPE = 'task.runtime_updated';

/** `<prefix>.*` patterns offered in the create dialog, from the event catalog. */
export function eventPatternOptions(types: readonly string[] = DOMAIN_EVENT_TYPES): string[] {
    return [...new Set(types.map((type) => `${type.split('.')[0]}.*`))].sort();
}

const STATUS_STYLE: Record<WebhookSubscription['status'], string> = {
    active: 'text-green-600',
    paused: 'text-muted-foreground',
    failed: 'text-red-600',
    disabled: 'text-red-600',
};

type T = ReturnType<typeof useTranslations>;

/**
 * Settings → Webhooks (EW-P1-5). Lists every subscription (active, paused,
 * failed, disabled), creates v2 domain-event subscriptions, pauses / resumes,
 * test-fires, rotates the signing secret (shown once), and shows a
 * subscription's deliveries with redelivery.
 */
export function WebhooksSettings({ initialSubscriptions, organizations, loadFailed }: Props) {
    const t = useTranslations('dashboard.settings.webhooksPage');
    const [subscriptions, setSubscriptions] = useState(initialSubscriptions);
    const [creating, setCreating] = useState(false);
    const [secret, setSecret] = useState<{ subscriptionId: string; value: string } | null>(null);
    const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
    /** Bumped after a test fire so an open deliveries panel shows the new attempt. */
    const [deliveriesVersion, setDeliveriesVersion] = useState(0);
    const [notice, setNotice] = useState<Record<string, { ok: boolean; message: string }>>({});
    const [pending, startTransition] = useTransition();

    const orgName = useMemo(() => {
        const byId = new Map(organizations.map((org) => [org.id, org.displayName || org.slug]));
        return (id: string) => byId.get(id) ?? id;
    }, [organizations]);

    function replace(subscription: WebhookSubscription) {
        setSubscriptions((prev) => prev.map((s) => (s.id === subscription.id ? subscription : s)));
    }

    function note(id: string, ok: boolean, message: string) {
        setNotice((prev) => ({ ...prev, [id]: { ok, message } }));
    }

    function setStatus(sub: WebhookSubscription, status: 'active' | 'paused') {
        startTransition(async () => {
            const result = await updateWebhook(sub.id, { status });
            if (result.success && result.subscription) {
                replace(result.subscription);
                note(sub.id, true, status === 'active' ? t('resumed') : t('pausedNotice'));
            } else {
                note(sub.id, false, result.error ?? t('updateFailed'));
            }
        });
    }

    function test(sub: WebhookSubscription) {
        startTransition(async () => {
            const result = await testWebhook(sub.id);
            if (result.result) {
                const outcome = result.result.ok
                    ? t('testDelivered', { outcome: result.result.outcome })
                    : t('testFailedOutcome', { outcome: result.result.outcome });
                const http = result.result.status
                    ? ` ${t('httpStatus', { status: result.result.status })}`
                    : '';
                note(sub.id, result.result.ok, `${outcome}${http}`);
            } else {
                note(sub.id, false, result.error ?? t('testFailed'));
            }
            // A failed test moves the failure streak (and can fail the
            // subscription): show the subscription as the server has it now.
            const fresh = await listWebhooks();
            const updated = fresh.subscriptions?.find((s) => s.id === sub.id);
            if (updated) replace(updated);
            setDeliveriesVersion((v) => v + 1);
        });
    }

    /**
     * Review 2026-10-17 U6: Rotate and Delete ask first. A v1 rotation stops the previous
     * secret at once, a delete cannot be undone, and a subscription an integration key
     * owns (Ever Gauzy) stops that integration's event feed.
     */
    function confirmed(sub: WebhookSubscription, action: 'rotate' | 'delete'): boolean {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
        const lines = [
            t(action === 'rotate' ? 'confirmRotate' : 'confirmDelete', { url: sub.url }),
        ];
        if (action === 'rotate' && sub.version !== 2) lines.push(t('confirmRotateV1'));
        if (sub.ownerType === 'integration_key') lines.push(t('confirmIntegrationOwned'));
        return window.confirm(lines.join('\n\n'));
    }

    function rotate(sub: WebhookSubscription) {
        if (!confirmed(sub, 'rotate')) return;
        startTransition(async () => {
            const result = await rotateWebhookSecret(sub.id);
            if (result.success && result.signingSecret) {
                setSecret({ subscriptionId: sub.id, value: result.signingSecret });
                note(sub.id, true, sub.version === 2 ? t('rotatedV2') : t('rotated'));
            } else {
                note(sub.id, false, result.error ?? t('rotateFailed'));
            }
        });
    }

    function remove(sub: WebhookSubscription) {
        if (!confirmed(sub, 'delete')) return;
        startTransition(async () => {
            const result = await deleteWebhook(sub.id);
            if (result.success) {
                setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id));
            } else {
                note(sub.id, false, result.error ?? t('deleteFailed'));
            }
        });
    }

    const secretUrl = secret
        ? (subscriptions.find((sub) => sub.id === secret.subscriptionId)?.url ?? null)
        : null;

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-lg font-semibold">{t('title')}</h2>
                    <p className="text-sm text-muted-foreground">{t('intro')}</p>
                </div>
                <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                    onClick={() => setCreating(true)}
                >
                    {t('newWebhook')}
                </button>
            </div>

            {secret && (
                <div
                    role="status"
                    className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950"
                >
                    <p className="font-medium">{t('secretTitle')}</p>
                    {/* U6: which subscription the secret belongs to. */}
                    {secretUrl && (
                        <p
                            className="break-all text-muted-foreground"
                            data-testid="webhook-secret-for"
                        >
                            {t('secretFor', { url: secretUrl })}
                        </p>
                    )}
                    <p className="text-muted-foreground">{t('secretHint')}</p>
                    <div className="mt-2 flex items-center gap-2">
                        <code
                            className="break-all rounded bg-background px-2 py-1"
                            data-testid="webhook-secret"
                        >
                            {secret.value}
                        </code>
                        <button
                            type="button"
                            className="text-sm underline"
                            onClick={() => void navigator.clipboard?.writeText(secret.value)}
                        >
                            {t('copy')}
                        </button>
                        <button
                            type="button"
                            className="text-sm underline"
                            onClick={() => setSecret(null)}
                        >
                            {t('done')}
                        </button>
                    </div>
                </div>
            )}

            {loadFailed && subscriptions.length === 0 ? (
                <p role="alert" className="text-sm text-red-600">
                    {t('loadFailed')}
                </p>
            ) : subscriptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b text-left">
                            <th className="py-2">{t('colEndpoint')}</th>
                            <th className="py-2">{t('colEvents')}</th>
                            <th className="py-2">{t('colStatus')}</th>
                            <th className="py-2 text-right">{t('colActions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {subscriptions.map((sub) => (
                            <WebhookRow
                                key={sub.id}
                                t={t}
                                sub={sub}
                                orgName={orgName}
                                info={notice[sub.id]}
                                busy={pending}
                                deliveriesOpen={openDeliveries === sub.id}
                                deliveriesVersion={deliveriesVersion}
                                onToggleDeliveries={() =>
                                    setOpenDeliveries((prev) => (prev === sub.id ? null : sub.id))
                                }
                                onPause={() => setStatus(sub, 'paused')}
                                onResume={() => setStatus(sub, 'active')}
                                onTest={() => test(sub)}
                                onRotate={() => rotate(sub)}
                                // U6: one secret on screen at a time — Done first.
                                rotateLocked={secret !== null && secret.subscriptionId !== sub.id}
                                onDelete={() => remove(sub)}
                            />
                        ))}
                    </tbody>
                </table>
            )}

            {creating && (
                <CreateWebhookDialog
                    t={t}
                    organizations={organizations}
                    onClose={() => setCreating(false)}
                    onCreated={(subscription, signingSecret) => {
                        setSubscriptions((prev) => [...prev, subscription]);
                        setSecret({ subscriptionId: subscription.id, value: signingSecret });
                        setCreating(false);
                    }}
                />
            )}
        </div>
    );
}

function WebhookRow({
    t,
    sub,
    orgName,
    info,
    busy,
    deliveriesOpen,
    deliveriesVersion,
    onToggleDeliveries,
    onPause,
    onResume,
    onTest,
    onRotate,
    onDelete,
    rotateLocked = false,
}: {
    t: T;
    sub: WebhookSubscription;
    orgName: (id: string) => string;
    info?: { ok: boolean; message: string };
    busy: boolean;
    deliveriesOpen: boolean;
    deliveriesVersion: number;
    onToggleDeliveries: () => void;
    onPause: () => void;
    onResume: () => void;
    onTest: () => void;
    onRotate: () => void;
    onDelete: () => void;
    /** Another subscription's new secret is still on screen (Done first). */
    rotateLocked?: boolean;
}) {
    const canResume = sub.status === 'paused' || sub.status === 'failed';
    return (
        <>
            <tr className="border-b align-top">
                <td className="py-2">
                    <div className="break-all font-medium">{sub.url}</div>
                    {sub.description && (
                        <div className="text-xs text-muted-foreground">{sub.description}</div>
                    )}
                    {sub.version === 2 && sub.organizationIds && (
                        <div className="text-xs text-muted-foreground">
                            {sub.organizationIds.map(orgName).join(', ')}
                        </div>
                    )}
                </td>
                <td className="py-2">
                    {sub.version === 2 ? (
                        <span className="text-xs">{(sub.events ?? []).join(', ')}</span>
                    ) : (
                        <span className="text-xs text-muted-foreground">{t('legacyEvents')}</span>
                    )}
                </td>
                <td className="py-2">
                    <span className={STATUS_STYLE[sub.status]}>{t(`status.${sub.status}`)}</span>
                    {sub.consecutiveFailures > 0 && (
                        <div className="text-xs text-muted-foreground">
                            {t('failedInARow', { count: sub.consecutiveFailures })}
                        </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                        {sub.lastDeliveryAt
                            ? t('lastDelivery', {
                                  when: new Date(sub.lastDeliveryAt).toLocaleString(),
                              })
                            : t('neverDelivered')}
                    </div>
                </td>
                <td className="py-2 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-3">
                        {info && (
                            <span
                                className={
                                    info.ok ? 'text-xs text-green-600' : 'text-xs text-red-600'
                                }
                            >
                                {info.message}
                            </span>
                        )}
                        {sub.status === 'active' && (
                            <button
                                type="button"
                                className="text-sm"
                                disabled={busy}
                                onClick={onPause}
                            >
                                {t('pause')}
                            </button>
                        )}
                        {canResume && (
                            <button
                                type="button"
                                className="text-sm"
                                disabled={busy}
                                onClick={onResume}
                            >
                                {t('resume')}
                            </button>
                        )}
                        <button type="button" className="text-sm" disabled={busy} onClick={onTest}>
                            {t('test')}
                        </button>
                        <button
                            type="button"
                            className="text-sm"
                            disabled={busy || rotateLocked}
                            onClick={onRotate}
                        >
                            {t('rotate')}
                        </button>
                        <button type="button" className="text-sm" onClick={onToggleDeliveries}>
                            {deliveriesOpen ? t('hideDeliveries') : t('deliveries')}
                        </button>
                        <button
                            type="button"
                            className="text-sm text-red-600"
                            disabled={busy}
                            onClick={onDelete}
                        >
                            {t('delete')}
                        </button>
                    </div>
                </td>
            </tr>
            {deliveriesOpen && (
                <tr className="border-b">
                    <td colSpan={4} className="py-2">
                        <DeliveriesPanel
                            t={t}
                            subscriptionId={sub.id}
                            refreshKey={deliveriesVersion}
                        />
                    </td>
                </tr>
            )}
        </>
    );
}

function DeliveriesPanel({
    t,
    subscriptionId,
    refreshKey,
}: {
    t: T;
    subscriptionId: string;
    refreshKey: number;
}) {
    const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Per delivery: a redelivery in flight, or the outcome of the last one. */
    const [redelivery, setRedelivery] = useState<
        Record<string, { state: 'sending' | 'sent' | 'failed'; error?: string }>
    >({});

    useEffect(() => {
        let cancelled = false;
        void listWebhookDeliveries(subscriptionId).then((result) => {
            if (cancelled) return;
            if (result.success) {
                setDeliveries(result.deliveries ?? []);
                setError(null);
            } else {
                setError(result.error ?? t('deliveriesLoadFailed'));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [subscriptionId, refreshKey, t]);

    async function redeliver(id: string) {
        // One request per click: the button stays disabled until it answers,
        // since every call queues a fresh delivery.
        if (redelivery[id]?.state === 'sending') return;
        setRedelivery((prev) => ({ ...prev, [id]: { state: 'sending' } }));
        const result = await redeliverWebhook(id);
        setRedelivery((prev) => ({
            ...prev,
            [id]: result.success
                ? { state: 'sent' }
                : { state: 'failed', error: result.error ?? '' },
        }));
    }

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (deliveries === null) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
    if (deliveries.length === 0) {
        return <p className="text-sm text-muted-foreground">{t('noDeliveries')}</p>;
    }
    return (
        <table className="w-full text-xs">
            <thead>
                <tr className="text-left">
                    <th className="py-1">{t('dEvent')}</th>
                    <th className="py-1">{t('dStatus')}</th>
                    <th className="py-1">{t('dAttempts')}</th>
                    <th className="py-1">{t('dResponse')}</th>
                    <th className="py-1">{t('dCreated')}</th>
                    <th className="py-1" />
                </tr>
            </thead>
            <tbody>
                {deliveries.map((d) => {
                    const state = redelivery[d.id];
                    return (
                        <tr key={d.id}>
                            <td className="py-1">{d.event}</td>
                            <td className="py-1">{d.status}</td>
                            <td className="py-1">{d.attempts}</td>
                            <td className="py-1">
                                {d.lastResponseStatus ?? d.lastOutcome ?? '—'}
                                {d.lastError ? ` · ${d.lastError}` : ''}
                            </td>
                            <td className="py-1">{new Date(d.createdAt).toLocaleString()}</td>
                            <td className="py-1 text-right">
                                {state?.state === 'sent' ? (
                                    t('resent')
                                ) : (
                                    <span className="inline-flex items-center gap-2">
                                        {state?.state === 'failed' && (
                                            <span className="text-red-600">
                                                {t('redeliverFailed', { error: state.error ?? '' })}
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            className="underline disabled:opacity-50"
                                            disabled={state?.state === 'sending'}
                                            onClick={() => void redeliver(d.id)}
                                        >
                                            {state?.state === 'sending'
                                                ? t('redelivering')
                                                : t('redeliver')}
                                        </button>
                                    </span>
                                )}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function CreateWebhookDialog({
    t,
    organizations,
    onClose,
    onCreated,
}: {
    t: T;
    organizations: TeamsOrganization[];
    onClose: () => void;
    onCreated: (subscription: WebhookSubscription, signingSecret: string) => void;
}) {
    const patterns = useMemo(() => eventPatternOptions(), []);
    const [url, setUrl] = useState('');
    const [description, setDescription] = useState('');
    const [orgIds, setOrgIds] = useState<string[]>(
        organizations.length === 1 ? [organizations[0].id] : [],
    );
    const [events, setEvents] = useState<string[]>(['task.*']);
    const [excludeTags, setExcludeTags] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, startSubmit] = useTransition();

    function toggle(list: string[], value: string): string[] {
        return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    }

    function submit() {
        setError(null);
        if (!/^https?:\/\//i.test(url.trim())) {
            setError(t('errUrl'));
            return;
        }
        if (orgIds.length === 0) {
            setError(t('errOrg'));
            return;
        }
        if (events.length === 0) {
            setError(t('errEvents'));
            return;
        }
        startSubmit(async () => {
            const result = await createWebhook({
                url: url.trim(),
                description: description.trim() || null,
                organizationIds: orgIds,
                events,
                excludeOriginTags: excludeTags
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter((tag) => tag.length > 0),
            });
            if (result.success && result.subscription && result.signingSecret) {
                onCreated(result.subscription, result.signingSecret);
            } else {
                setError(result.error ?? t('createFailed'));
            }
        });
    }

    return (
        <div
            role="dialog"
            aria-label={t('dialogTitle')}
            className="space-y-4 rounded-md border p-4"
        >
            <h3 className="font-semibold">{t('dialogTitle')}</h3>
            <label className="block text-sm">
                {t('endpointUrl')}
                <input
                    type="url"
                    className="mt-1 w-full rounded-md border px-2 py-1"
                    placeholder="https://example.com/ever-works"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
            </label>
            <label className="block text-sm">
                {t('description')}
                <input
                    type="text"
                    className="mt-1 w-full rounded-md border px-2 py-1"
                    maxLength={500}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
            </label>
            <fieldset className="text-sm">
                <legend className="font-medium">{t('organizations')}</legend>
                {organizations.length === 0 && (
                    <p className="text-muted-foreground">{t('noOrganizations')}</p>
                )}
                {organizations.map((org) => (
                    <label key={org.id} className="mr-4 inline-flex items-center gap-1">
                        <input
                            type="checkbox"
                            checked={orgIds.includes(org.id)}
                            onChange={() => setOrgIds((prev) => toggle(prev, org.id))}
                        />
                        {org.displayName || org.slug}
                    </label>
                ))}
            </fieldset>
            <fieldset className="text-sm">
                <legend className="font-medium">{t('events')}</legend>
                {patterns.map((pattern) => (
                    <label key={pattern} className="mr-4 inline-flex items-center gap-1">
                        <input
                            type="checkbox"
                            checked={events.includes(pattern)}
                            onChange={() => setEvents((prev) => toggle(prev, pattern))}
                        />
                        <code>{pattern}</code>
                    </label>
                ))}
                <label className="mr-4 inline-flex items-center gap-1">
                    <input
                        type="checkbox"
                        checked={events.includes(RUNTIME_TYPE)}
                        onChange={() => setEvents((prev) => toggle(prev, RUNTIME_TYPE))}
                    />
                    <code>{RUNTIME_TYPE}</code>
                    <span className="text-muted-foreground">{t('runtimeHint')}</span>
                </label>
            </fieldset>
            <label className="block text-sm">
                {t('skipOrigins')}
                <input
                    type="text"
                    className="mt-1 w-full rounded-md border px-2 py-1"
                    placeholder="gauzy:<connection-id>"
                    value={excludeTags}
                    onChange={(e) => setExcludeTags(e.target.value)}
                />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
                <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                    disabled={submitting}
                    onClick={submit}
                >
                    {submitting ? t('creating') : t('create')}
                </button>
                <button
                    type="button"
                    className="rounded-md border px-3 py-2 text-sm"
                    onClick={onClose}
                >
                    {t('cancel')}
                </button>
            </div>
        </div>
    );
}
