'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Scheduled Memory Consolidation — the settings that turn it on.
 *
 * Consolidation could always be run by hand from this page, and a
 * scheduled pass existed in the worker. But the scheduler selects
 * organizations whose settings column is non-null, and nothing in the
 * product ever wrote that column — so the scheduled pass had no way to
 * become active for anybody. This control is that write.
 *
 * `mode` is the one to read carefully:
 *   dry-run  — compute and report, persist nothing
 *   propose  — persist markers and land LLM syntheses as `proposed`,
 *              which appear in the review queue and are withheld from
 *              agent context until a human accepts them
 * Neither ever auto-accepts, and neither deletes anything.
 */

interface Settings {
    enabled: boolean;
    cadence: string;
    mode: string;
    notify: boolean;
    lastRunAt?: string | null;
}

const CADENCES = ['daily', 'weekly', 'monthly'] as const;
const MODES = ['dry-run', 'propose'] as const;

export function MemoryConsolidationSettings() {
    const t = useTranslations('dashboard.memoryPage.schedule');
    const [settings, setSettings] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch('/api/memory/consolidation/settings', {
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });
                if (!res.ok || cancelled) return;
                const body = (await res.json()) as Settings;
                if (!cancelled) setSettings(body);
            } catch {
                // Leave the panel unrendered rather than showing controls
                // whose current state we could not read.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const save = useCallback(async (patch: Partial<Settings>) => {
        setSaving(true);
        // Optimistic so the control responds immediately — but a settings
        // form must never keep a value it failed to store. Both the error
        // and the non-ok paths roll back to what was actually saved,
        // otherwise a failed write reads as success and the user believes
        // the schedule is on when it is not.
        let previous: Settings | null = null;
        setSettings((prev) => {
            previous = prev;
            return prev ? { ...prev, ...patch } : prev;
        });
        try {
            const res = await fetch('/api/memory/consolidation/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.ok) {
                setSettings(previous);
                return;
            }
            const body = (await res.json()) as Settings;
            setSettings(body);
        } catch {
            setSettings(previous);
        } finally {
            setSaving(false);
        }
    }, []);

    if (!settings) return null;

    return (
        <div
            data-testid="memory-schedule-panel"
            className={cn(
                'flex flex-col gap-3 rounded-lg border p-4',
                'bg-card dark:bg-card-primary-dark',
                'border-card-border dark:border-white/9',
            )}
        >
            <div className="flex items-center gap-2">
                <CalendarClock
                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0"
                    strokeWidth={1.5}
                />
                <span className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </span>
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
            </div>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('subtitle')}</p>

            <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark">
                    <input
                        type="checkbox"
                        data-testid="memory-schedule-enabled"
                        checked={settings.enabled}
                        onChange={(e) => void save({ enabled: e.target.checked })}
                        className="h-4 w-4"
                    />
                    {t('enabled')}
                </label>

                <label className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('cadence')}
                    <select
                        data-testid="memory-schedule-cadence"
                        value={settings.cadence}
                        disabled={!settings.enabled}
                        onChange={(e) => void save({ cadence: e.target.value })}
                        className={cn(
                            'rounded-lg border bg-transparent px-2 py-1 text-xs',
                            'border-border dark:border-white/15',
                            'disabled:cursor-not-allowed disabled:opacity-40',
                        )}
                    >
                        {CADENCES.map((c) => (
                            <option key={c} value={c}>
                                {t(`cadences.${c}`)}
                            </option>
                        ))}
                    </select>
                </label>

                <label className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('mode')}
                    <select
                        data-testid="memory-schedule-mode"
                        value={settings.mode}
                        disabled={!settings.enabled}
                        onChange={(e) => void save({ mode: e.target.value })}
                        className={cn(
                            'rounded-lg border bg-transparent px-2 py-1 text-xs',
                            'border-border dark:border-white/15',
                            'disabled:cursor-not-allowed disabled:opacity-40',
                        )}
                    >
                        {MODES.map((m) => (
                            <option key={m} value={m}>
                                {t(`modes.${m}`)}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {settings.lastRunAt && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('lastRun', { when: new Date(settings.lastRunAt).toLocaleString() })}
                </p>
            )}
        </div>
    );
}
