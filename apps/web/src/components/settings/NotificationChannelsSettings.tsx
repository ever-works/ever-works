'use client';

import { useState } from 'react';
import type { NotificationChannel } from '@/lib/api/notification-channels';

interface Props {
    initialChannels: NotificationChannel[];
}

/**
 * EW-663 / EW-679 — Notification Channels settings UI shell.
 */
export function NotificationChannelsSettings({ initialChannels }: Props) {
    const [channels] = useState(initialChannels);

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
                    onClick={() => {
                        // TODO(EW-679 follow-up): open AddChannelWizard sheet
                        alert('Add-channel wizard: implementation in follow-up tick');
                    }}
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
                        {channels.map((c) => (
                            <tr key={c.id} className="border-b">
                                <td className="py-2 font-medium">{c.name}</td>
                                <td className="py-2">{c.pluginId}</td>
                                <td className="py-2">{c.verified ? '✓' : '—'}</td>
                                <td className="py-2 text-right">
                                    <button type="button" className="text-sm text-muted-foreground">
                                        Test
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
