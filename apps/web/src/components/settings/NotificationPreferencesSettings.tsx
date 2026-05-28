'use client';

import { useMemo } from 'react';
import type {
    NotificationEventType,
    PreferencesView,
} from '@/lib/api/notification-preferences';
import type { NotificationChannel } from '@/lib/api/notification-channels';

interface Props {
    initialEventTypes: NotificationEventType[];
    initialPreferences: PreferencesView;
    initialChannels: NotificationChannel[];
}

/**
 * EW-664 / EW-679 — Notification Preferences matrix UI shell.
 *
 * v0: renders the event × channel grid as a read-only table; PUT
 * wiring for each cell lands in a follow-up. The in-app column is
 * always present (built-in channel).
 */
export function NotificationPreferencesSettings({
    initialEventTypes,
    initialPreferences,
    initialChannels,
}: Props) {
    const columns = useMemo(
        () => [
            { id: 'in-app', label: 'In-app' },
            ...initialChannels.map((c) => ({ id: c.id, label: c.name })),
        ],
        [initialChannels],
    );

    const subsByEvent = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const sub of initialPreferences.subscriptions) {
            map.set(sub.eventTypeKey, new Set(sub.channelIds));
        }
        return map;
    }, [initialPreferences.subscriptions]);

    if (initialEventTypes.length === 0) {
        return (
            <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground">
                    No event types registered yet. Producers will populate the registry on first
                    emission.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-2xl font-semibold">Notification Preferences</h1>
                <p className="text-sm text-muted-foreground">
                    Pick which channels deliver each event. In-app delivery is always on.
                </p>
            </header>

            <table className="w-full text-sm">
                <thead className="border-b text-left text-muted-foreground">
                    <tr>
                        <th className="py-2">Event</th>
                        {columns.map((c) => (
                            <th key={c.id} className="py-2 text-center">
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {initialEventTypes.map((event) => {
                        const enabled = subsByEvent.get(event.key) ?? new Set(event.defaultChannels);
                        return (
                            <tr key={event.key} className="border-b">
                                <td className="py-2">
                                    <div className="font-medium">{event.title}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {event.description}
                                    </div>
                                </td>
                                {columns.map((c) => (
                                    <td key={c.id} className="py-2 text-center">
                                        <input
                                            type="checkbox"
                                            defaultChecked={enabled.has(c.id)}
                                            aria-label={`${event.title} → ${c.label}`}
                                        />
                                    </td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
