'use client';

import { useState, useTransition } from 'react';
import type { NotificationChannel } from '@/lib/api/notification-channels';
import {
    createNotificationChannel,
    sendNotificationChannelTest,
    deleteNotificationChannel,
} from '@/app/actions/notification-channels';

interface Props {
    initialChannels: NotificationChannel[];
}

interface ProviderField {
    key: string;
    label: string;
    type: 'text' | 'url' | 'password';
    placeholder?: string;
}

interface ProviderDef {
    id: string;
    label: string;
    fields: ProviderField[];
}

/**
 * Add-channel wizard provider catalog. Each provider's `fields` map to the
 * `targetConfig` keys the matching channel plugin validates (see
 * `packages/plugins/<provider>-channel`).
 */
const PROVIDERS: ProviderDef[] = [
    {
        id: 'discord-channel',
        label: 'Discord',
        fields: [
            {
                key: 'webhookUrl',
                label: 'Webhook URL',
                type: 'url',
                placeholder: 'https://discord.com/api/webhooks/…',
            },
        ],
    },
    {
        id: 'slack-channel',
        label: 'Slack',
        fields: [
            {
                key: 'webhookUrl',
                label: 'Incoming Webhook URL',
                type: 'url',
                placeholder: 'https://hooks.slack.com/services/…',
            },
        ],
    },
    {
        id: 'telegram-channel',
        label: 'Telegram',
        fields: [
            {
                key: 'botToken',
                label: 'Bot Token',
                type: 'password',
                placeholder: '123456:ABC-DEF…',
            },
            {
                key: 'chatId',
                label: 'Chat ID',
                type: 'text',
                placeholder: '@channel or numeric id',
            },
        ],
    },
    {
        id: 'whatsapp-channel',
        label: 'WhatsApp',
        fields: [
            { key: 'accessToken', label: 'Access Token', type: 'password' },
            { key: 'phoneNumberId', label: 'Phone Number ID', type: 'text' },
            { key: 'to', label: 'Recipient (to)', type: 'text', placeholder: '+15551234567' },
        ],
    },
    {
        id: 'novu-channel',
        label: 'Novu',
        fields: [
            { key: 'apiKey', label: 'API Key', type: 'password' },
            { key: 'workflowId', label: 'Workflow ID', type: 'text' },
            { key: 'subscriberId', label: 'Subscriber ID', type: 'text' },
        ],
    },
];

type TestState = { status: 'ok' | 'error'; message: string };

/**
 * EW-663 / EW-679 — Notification Channels settings UI.
 * Lists channels and provides the Add-channel wizard, per-row Test, and
 * Remove actions (all via server actions in `app/actions/notification-channels`).
 */
export function NotificationChannelsSettings({ initialChannels }: Props) {
    const [channels, setChannels] = useState<NotificationChannel[]>(initialChannels);
    const [wizardOpen, setWizardOpen] = useState(false);
    const [testResults, setTestResults] = useState<Record<string, TestState>>({});
    // Per-channel pending sets — multiple rows can run Test/Remove
    // concurrently, so a single id can't be shared (Greptile P1).
    const [pendingTestIds, setPendingTestIds] = useState<ReadonlySet<string>>(new Set());
    const [pendingRemoveIds, setPendingRemoveIds] = useState<ReadonlySet<string>>(new Set());
    const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
    const [, startTransition] = useTransition();

    function withId(set: ReadonlySet<string>, id: string, present: boolean): Set<string> {
        const next = new Set(set);
        if (present) next.add(id);
        else next.delete(id);
        return next;
    }

    function handleTest(id: string) {
        setPendingTestIds((prev) => withId(prev, id, true));
        startTransition(async () => {
            const result = await sendNotificationChannelTest(id);
            setTestResults((prev) => ({
                ...prev,
                [id]: result.success
                    ? {
                          status: 'ok',
                          message: `Sent${result.status ? ` (${result.status})` : ''}`,
                      }
                    : { status: 'error', message: result.error ?? 'Test failed' },
            }));
            setPendingTestIds((prev) => withId(prev, id, false));
        });
    }

    function handleRemove(id: string) {
        setPendingRemoveIds((prev) => withId(prev, id, true));
        setRemoveErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        startTransition(async () => {
            const result = await deleteNotificationChannel(id);
            if (result.success) {
                setChannels((prev) => prev.filter((c) => c.id !== id));
                setTestResults((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            } else {
                setRemoveErrors((prev) => ({
                    ...prev,
                    [id]: result.error ?? 'Failed to remove channel',
                }));
            }
            setPendingRemoveIds((prev) => withId(prev, id, false));
        });
    }

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">Notification Channels</h1>
                    <p className="text-sm text-muted-foreground">
                        Connect Discord, Slack, Telegram, WhatsApp or Novu for multi-channel
                        notification delivery.
                    </p>
                </div>
                <button
                    type="button"
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                    onClick={() => setWizardOpen(true)}
                >
                    Add channel
                </button>
            </header>

            {channels.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        No channels yet. Add a Discord webhook, Slack incoming webhook, Telegram
                        bot, or Novu workflow to start fanning notifications out beyond in-app.
                    </p>
                </div>
            ) : (
                <table className="w-full text-sm">
                    <thead className="border-b text-left text-muted-foreground">
                        <tr>
                            <th className="py-2">Name</th>
                            <th className="py-2">Provider</th>
                            <th className="py-2">Verified</th>
                            <th className="py-2"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {channels.map((c) => {
                            const test = testResults[c.id];
                            const removeError = removeErrors[c.id];
                            const testing = pendingTestIds.has(c.id);
                            const removing = pendingRemoveIds.has(c.id);
                            return (
                                <tr key={c.id} className="border-b">
                                    <td className="py-2 font-medium">{c.name}</td>
                                    <td className="py-2">{providerLabel(c.pluginId)}</td>
                                    <td className="py-2">{c.verified ? '✓' : '—'}</td>
                                    <td className="py-2 text-right">
                                        <div className="flex items-center justify-end gap-3">
                                            {removeError && (
                                                <span className="text-xs text-red-600">
                                                    ✗ {removeError}
                                                </span>
                                            )}
                                            {test && (
                                                <span
                                                    className={
                                                        test.status === 'ok'
                                                            ? 'text-xs text-green-600'
                                                            : 'text-xs text-red-600'
                                                    }
                                                >
                                                    {test.status === 'ok' ? '✓ ' : '✗ '}
                                                    {test.message}
                                                </span>
                                            )}
                                            <button
                                                type="button"
                                                className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                                                disabled={testing}
                                                onClick={() => handleTest(c.id)}
                                            >
                                                {testing ? 'Testing…' : 'Test'}
                                            </button>
                                            <button
                                                type="button"
                                                className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                                                disabled={removing}
                                                onClick={() => handleRemove(c.id)}
                                            >
                                                {removing ? 'Removing…' : 'Remove'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}

            {wizardOpen && (
                <AddChannelWizard
                    onClose={() => setWizardOpen(false)}
                    onCreated={(channel) => {
                        setChannels((prev) => [...prev, channel]);
                        setWizardOpen(false);
                    }}
                />
            )}
        </div>
    );
}

function providerLabel(pluginId: string): string {
    return PROVIDERS.find((p) => p.id === pluginId)?.label ?? pluginId;
}

function AddChannelWizard({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: (channel: NotificationChannel) => void;
}) {
    const [provider, setProvider] = useState<ProviderDef>(PROVIDERS[0]);
    const [name, setName] = useState('');
    const [values, setValues] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [submitting, startSubmit] = useTransition();

    function setField(key: string, value: string) {
        setValues((prev) => ({ ...prev, [key]: value }));
    }

    function selectProvider(id: string) {
        const next = PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
        setProvider(next);
        setValues({});
        setError(null);
    }

    function submit() {
        setError(null);
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError('Name is required.');
            return;
        }
        // `let` (not const) per the team style rule for objects whose
        // properties are assigned after declaration (Greptile).
        let targetConfig: Record<string, string> = {};
        for (const field of provider.fields) {
            const v = (values[field.key] ?? '').trim();
            if (!v) {
                setError(`${field.label} is required.`);
                return;
            }
            targetConfig[field.key] = v;
        }
        startSubmit(async () => {
            const result = await createNotificationChannel({
                pluginId: provider.id,
                name: trimmedName,
                targetConfig,
            });
            if (result.success && result.channel) {
                onCreated(result.channel);
            } else {
                setError(result.error ?? 'Failed to create channel.');
            }
        });
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Add notification channel"
        >
            <div className="w-full max-w-md space-y-4 rounded-lg border bg-background p-6 shadow-lg">
                <div>
                    <h2 className="text-lg font-semibold">Add channel</h2>
                    <p className="text-sm text-muted-foreground">
                        Pick a provider and enter its delivery details. You can send a test after
                        saving.
                    </p>
                </div>

                <label className="block space-y-1">
                    <span className="text-sm font-medium">Provider</span>
                    <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={provider.id}
                        onChange={(e) => selectProvider(e.target.value)}
                    >
                        {PROVIDERS.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.label}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="block space-y-1">
                    <span className="text-sm font-medium">Name</span>
                    <input
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={`My ${provider.label} channel`}
                    />
                </label>

                {provider.fields.map((field) => (
                    <label key={field.key} className="block space-y-1">
                        <span className="text-sm font-medium">{field.label}</span>
                        <input
                            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                            type={field.type === 'url' ? 'text' : field.type}
                            value={values[field.key] ?? ''}
                            onChange={(e) => setField(field.key, e.target.value)}
                            placeholder={field.placeholder}
                        />
                    </label>
                ))}

                {error && <p className="text-sm text-red-600">{error}</p>}

                <div className="flex justify-end gap-3 pt-2">
                    <button
                        type="button"
                        className="rounded-md border px-4 py-2 text-sm font-medium"
                        onClick={onClose}
                        disabled={submitting}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                        onClick={submit}
                        disabled={submitting}
                    >
                        {submitting ? 'Creating…' : 'Create channel'}
                    </button>
                </div>
            </div>
        </div>
    );
}
