'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT,
    FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MAX,
    FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MIN,
    type FleetNodeView,
} from '@ever-works/contracts';
import { Switch } from '@/components/ui/switch';
import { setFleetNodeDesktopRecordingSettingsAction } from '@/app/actions/settings/fleet';

/** The retention choices offered (the platform accepts any whole number of days from 1 to 90). */
const RETENTION_CHOICES = [1, 3, 7, 14, 30, 60, 90] as const;

/**
 * Desktop view & control (FL-07 P3, spec §5.9) — a computer's recording
 * settings on its Settings tab, owner only: **Record watching sessions**
 * (`recordWatchSessions`, off by default; a view under control is always
 * recorded) and **Keep recordings for** (`recordingRetentionDays`, 1–90 days,
 * default 14). Saved through `PATCH /api/fleet/nodes/:id`, audited there as
 * `node.policy.change`.
 */
export function DesktopRecordingSettings({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.desktop.recordings.settings');
    const retentionId = useId();
    const [watch, setWatch] = useState(Boolean(node.recordWatchSessions));
    const [days, setDays] = useState(
        clampDays(node.recordingRetentionDays ?? FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT),
    );
    const [saving, setSaving] = useState(false);
    const choices = RETENTION_CHOICES.includes(days as (typeof RETENTION_CHOICES)[number])
        ? [...RETENTION_CHOICES]
        : [...RETENTION_CHOICES, days].sort((a, b) => a - b);

    const save = async (
        settings: { recordWatchSessions?: boolean; recordingRetentionDays?: number },
        undo: () => void,
    ) => {
        setSaving(true);
        try {
            const result = await setFleetNodeDesktopRecordingSettingsAction(node.id, settings);
            if (!result.success) {
                undo();
                toast.error(result.error || t('failed'));
                return;
            }
            toast.success(t('saved'));
        } catch {
            undo();
            toast.error(t('failed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="space-y-3" data-testid="fleet-desktop-recording-settings">
            <div>
                <h3 className="text-sm font-semibold">{t('title')}</h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('body')}</p>
            </div>
            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-sm font-medium">{t('watch')}</p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('watchHint')}
                    </p>
                </div>
                <Switch
                    checked={watch}
                    disabled={saving}
                    label={t('watch')}
                    onChange={(next) => {
                        const before = watch;
                        setWatch(next);
                        void save({ recordWatchSessions: next }, () => setWatch(before));
                    }}
                    data-testid="fleet-desktop-record-watch-toggle"
                />
            </div>
            <div className="flex items-start justify-between gap-4">
                <div>
                    <label htmlFor={retentionId} className="text-sm font-medium">
                        {t('retention')}
                    </label>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('retentionHint')}
                    </p>
                </div>
                <select
                    id={retentionId}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={days}
                    disabled={saving}
                    onChange={(event) => {
                        const before = days;
                        const next = clampDays(Number(event.target.value));
                        setDays(next);
                        void save({ recordingRetentionDays: next }, () => setDays(before));
                    }}
                    data-testid="fleet-desktop-recording-retention"
                >
                    {choices.map((choice) => (
                        <option key={choice} value={choice}>
                            {t('days', { count: choice })}
                        </option>
                    ))}
                </select>
            </div>
        </section>
    );
}

function clampDays(value: number): number {
    if (!Number.isFinite(value)) return FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT;
    return Math.min(
        FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MAX,
        Math.max(FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MIN, Math.round(value)),
    );
}
