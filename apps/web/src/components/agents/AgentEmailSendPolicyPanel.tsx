'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { AgentInboxMode } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    AGENT_INBOX_CAP_FIELDS,
    AGENT_INBOX_CAP_FIELD_TO_CAP,
    formatCapInput,
    parseCapInput,
    type AgentEmailSendPolicyView,
    type AgentInboxCapField,
} from '@/lib/agent-email-policy';
import type { AgentEmailAssignment, AgentInboxSettingsInput } from '@/lib/api/email-addresses';
import {
    assignAgentAddressAction,
    removeAgentAddressAction,
    saveAgentInboxSettingsAction,
} from '@/app/[locale]/(dashboard)/agents/[id]/inbox/actions';

export interface AgentEmailAddressOption {
    id: string;
    address: string;
    direction: 'outbound' | 'inbound' | 'both';
}

interface Props {
    agentId: string;
    /** `null` when the policy could not be read — the panel then stays out of the way. */
    initialPolicy: AgentEmailSendPolicyView | null;
    initialAssignments: AgentEmailAssignment[];
    addresses: AgentEmailAddressOption[];
}

type Notice = { tone: 'ok' | 'error'; text: string } | null;

/**
 * Agent email (AW-05) — the per-Agent sending policy and address
 * assignments, on the Agent's Inbox tab.
 *
 * Everything here is a REQUEST to change policy. Enforcement happens on the
 * server when a message is sent, so this panel can be stale, closed or
 * bypassed without any message escaping review or a limit.
 */
export function AgentEmailSendPolicyPanel({
    agentId,
    initialPolicy,
    initialAssignments,
    addresses,
}: Props) {
    const t = useTranslations('dashboard.agentsPage.email');
    const [policy, setPolicy] = useState(initialPolicy);
    const [mode, setMode] = useState<AgentInboxMode>(initialPolicy?.meter.mode ?? 'draft-review');
    const [confirmingAutoSend, setConfirmingAutoSend] = useState(false);
    const [caps, setCaps] = useState<Record<AgentInboxCapField, string>>(() =>
        capsToInputs(initialPolicy),
    );
    const [assignments, setAssignments] = useState(initialAssignments);
    const [newAddressId, setNewAddressId] = useState('');
    const [newUse, setNewUse] = useState<'outbound' | 'inbound'>('outbound');
    const [policyNotice, setPolicyNotice] = useState<Notice>(null);
    const [addressNotice, setAddressNotice] = useState<Notice>(null);
    const [isSaving, startSaving] = useTransition();
    const [isAssigning, startAssigning] = useTransition();

    const invalidFields = useMemo(
        () => AGENT_INBOX_CAP_FIELDS.filter((field) => parseCapInput(caps[field]) === undefined),
        [caps],
    );

    if (!policy) return null;
    const { meter, inbox } = policy;
    const addressById = new Map(addresses.map((address) => [address.id, address]));

    const chooseMode = (next: AgentInboxMode) => {
        if (next === mode) return;
        if (next === 'auto-send') {
            // Turning the gate off is the one irreversible-feeling choice
            // here — ask first, and only flip after an explicit yes.
            setConfirmingAutoSend(true);
            return;
        }
        setConfirmingAutoSend(false);
        setMode(next);
    };

    const save = () => {
        if (invalidFields.length > 0) {
            setPolicyNotice({ tone: 'error', text: t('policy.invalidNumber') });
            return;
        }
        const input: AgentInboxSettingsInput = {};
        // Always name the mode on the first save: a new settings row would
        // otherwise start in draft review, silently changing what the Agent
        // does today.
        if (!inbox || mode !== meter.mode || meter.modeSource !== 'inbox') input.mode = mode;
        for (const field of AGENT_INBOX_CAP_FIELDS) {
            const next = parseCapInput(caps[field]);
            const current = inbox ? inbox.caps[AGENT_INBOX_CAP_FIELD_TO_CAP[field]] : null;
            if (next !== current) input[field] = next as number | null;
        }
        startSaving(async () => {
            const result = await saveAgentInboxSettingsAction(agentId, input);
            if (result.ok) {
                setPolicy(result.policy);
                setMode(result.policy.meter.mode);
                setCaps(capsToInputs(result.policy));
                setPolicyNotice({ tone: 'ok', text: t('policy.saved') });
            } else {
                setPolicyNotice({ tone: 'error', text: t('policy.saveFailed') });
            }
        });
    };

    const assign = () => {
        if (!newAddressId) return;
        startAssigning(async () => {
            const result = await assignAgentAddressAction(agentId, {
                emailAddressId: newAddressId,
                direction: newUse,
            });
            if (result.ok) {
                setAssignments((rows) => [...rows, result.assignment]);
                setNewAddressId('');
                setAddressNotice(null);
            } else {
                setAddressNotice({
                    tone: 'error',
                    text:
                        result.error === 'duplicate'
                            ? t('addresses.duplicate')
                            : t('addresses.failed'),
                });
            }
        });
    };

    const remove = (assignmentId: string) => {
        startAssigning(async () => {
            const result = await removeAgentAddressAction(agentId, assignmentId);
            if (result.ok) {
                setAssignments((rows) => rows.filter((row) => row.id !== assignmentId));
                setAddressNotice(null);
            } else {
                setAddressNotice({ tone: 'error', text: t('addresses.failed') });
            }
        });
    };

    const assignable = addresses.filter(
        (address) => address.direction === 'both' || address.direction === newUse,
    );

    return (
        <section className="space-y-6 rounded-lg border p-4" data-testid="agent-email-send-policy">
            <div className="space-y-3">
                <div>
                    <h2 className="text-lg font-semibold">{t('policy.title')}</h2>
                    <p className="text-sm text-muted-foreground">{t('policy.description')}</p>
                </div>

                {meter.pausedUntil ? (
                    <p
                        role="status"
                        className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900"
                    >
                        {t('policy.pausedUntil', {
                            time: new Date(meter.pausedUntil).toLocaleTimeString(),
                        })}
                    </p>
                ) : null}

                <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">{t('policy.modeLabel')}</legend>
                    {(['draft-review', 'auto-send'] as const).map((option) => (
                        <label key={option} className="flex items-center gap-2 text-sm">
                            <input
                                type="radio"
                                name={`email-mode-${agentId}`}
                                value={option}
                                checked={mode === option}
                                onChange={() => chooseMode(option)}
                            />
                            {option === 'draft-review'
                                ? t('policy.modeDraftReview')
                                : t('policy.modeAutoSend')}
                        </label>
                    ))}
                    <p className="text-xs text-muted-foreground">
                        {t(`policy.modeSource.${meter.modeSource}`)}
                    </p>
                    {confirmingAutoSend ? (
                        <div
                            role="alertdialog"
                            aria-label={t('policy.autoSendConfirm')}
                            className="space-y-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
                        >
                            <p>{t('policy.autoSendConfirm')}</p>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    className="rounded-md border px-2 py-1"
                                    onClick={() => setConfirmingAutoSend(false)}
                                >
                                    {t('policy.keepGate')}
                                </button>
                                <button
                                    type="button"
                                    className="rounded-md bg-red-700 px-2 py-1 text-white"
                                    onClick={() => {
                                        setMode('auto-send');
                                        setConfirmingAutoSend(false);
                                    }}
                                >
                                    {t('policy.turnItOff')}
                                </button>
                            </div>
                        </div>
                    ) : null}
                </fieldset>

                <div className="space-y-2">
                    <h3 className="text-sm font-medium">{t('policy.limitsTitle')}</h3>
                    {meter.enforced ? (
                        <p className="text-xs text-muted-foreground">{t('policy.limitsHint')}</p>
                    ) : (
                        <p className="text-xs text-amber-700">{t('policy.enforcedOff')}</p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                        {AGENT_INBOX_CAP_FIELDS.map((field) => (
                            <label key={field} className="space-y-1 text-sm">
                                <span className="block">{t(`policy.fields.${field}`)}</span>
                                <input
                                    inputMode="numeric"
                                    value={caps[field]}
                                    placeholder={t('policy.inheritPlaceholder')}
                                    aria-invalid={invalidFields.includes(field)}
                                    onChange={(e) =>
                                        setCaps((prev) => ({ ...prev, [field]: e.target.value }))
                                    }
                                    className="w-full rounded-md border px-3 py-1.5 text-sm"
                                    data-testid={`email-cap-${field}`}
                                />
                            </label>
                        ))}
                    </div>
                    <ul className="space-y-1 text-sm" data-testid="email-cap-meter">
                        {meter.windows.map((window) => (
                            <li key={window.kind} className="flex flex-wrap justify-between gap-2">
                                <span>{t(`policy.windows.${window.kind}`)}</span>
                                <span className="text-muted-foreground">
                                    {window.kind === 'recipientsPerMessage'
                                        ? window.cap === null
                                            ? '—'
                                            : window.cap
                                        : window.cap === null
                                          ? t('policy.usageUnlimited', { used: window.used })
                                          : t('policy.usage', {
                                                used: window.used,
                                                cap: window.cap,
                                            })}{' '}
                                    ·{' '}
                                    {t('policy.sourceLabel', {
                                        source: t(`policy.source.${window.source}`),
                                    })}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={save}
                        disabled={isSaving}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                        {isSaving ? t('policy.saving') : t('policy.save')}
                    </button>
                    {policyNotice ? (
                        <span
                            role="status"
                            className={
                                policyNotice.tone === 'ok'
                                    ? 'text-sm text-green-700'
                                    : 'text-sm text-red-700'
                            }
                        >
                            {policyNotice.text}
                        </span>
                    ) : null}
                </div>
            </div>

            <div className="space-y-3 border-t pt-4">
                <div>
                    <h2 className="text-lg font-semibold">{t('addresses.title')}</h2>
                    <p className="text-sm text-muted-foreground">{t('addresses.description')}</p>
                </div>
                {assignments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('addresses.empty')}</p>
                ) : (
                    <ul className="space-y-1 text-sm" data-testid="agent-email-assignments">
                        {assignments.map((row) => (
                            <li key={row.id} className="flex items-center justify-between gap-2">
                                <span>
                                    {row.address ??
                                        addressById.get(row.emailAddressId)?.address ??
                                        '—'}{' '}
                                    <span className="text-muted-foreground">
                                        · {t('addresses.usedFor')}:{' '}
                                        {row.direction === 'outbound'
                                            ? t('addresses.sending')
                                            : t('addresses.receiving')}
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    onClick={() => remove(row.id)}
                                    disabled={isAssigning}
                                    className="rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
                                >
                                    {t('addresses.remove')}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {addresses.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t('addresses.noAddresses')}{' '}
                        <Link href={ROUTES.DASHBOARD_SETTINGS_EMAILS} className="underline">
                            {t('addresses.manage')}
                        </Link>
                    </p>
                ) : (
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            aria-label={t('addresses.choose')}
                            value={newAddressId}
                            onChange={(e) => setNewAddressId(e.target.value)}
                            className="rounded-md border px-2 py-1.5 text-sm"
                        >
                            <option value="">{t('addresses.choose')}</option>
                            {assignable.map((address) => (
                                <option key={address.id} value={address.id}>
                                    {address.address}
                                </option>
                            ))}
                        </select>
                        <select
                            aria-label={t('addresses.usedFor')}
                            value={newUse}
                            onChange={(e) => {
                                setNewUse(e.target.value as 'outbound' | 'inbound');
                                setNewAddressId('');
                            }}
                            className="rounded-md border px-2 py-1.5 text-sm"
                        >
                            <option value="outbound">{t('addresses.sending')}</option>
                            <option value="inbound">{t('addresses.receiving')}</option>
                        </select>
                        <button
                            type="button"
                            onClick={assign}
                            disabled={isAssigning || !newAddressId}
                            className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                        >
                            {t('addresses.add')}
                        </button>
                    </div>
                )}
                {addressNotice ? (
                    <p role="status" className="text-sm text-red-700">
                        {addressNotice.text}
                    </p>
                ) : null}
            </div>
        </section>
    );
}

function capsToInputs(policy: AgentEmailSendPolicyView | null): Record<AgentInboxCapField, string> {
    const out = {} as Record<AgentInboxCapField, string>;
    for (const field of AGENT_INBOX_CAP_FIELDS) {
        out[field] = formatCapInput(policy?.inbox?.caps[AGENT_INBOX_CAP_FIELD_TO_CAP[field]]);
    }
    return out;
}
