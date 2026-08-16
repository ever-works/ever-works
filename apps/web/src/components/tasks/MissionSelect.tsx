'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, Pause, Target, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { listMissionsAction } from '@/app/actions/dashboard/missions';
import { cn } from '@/lib/utils/cn';
import type { MissionStatus } from '@/lib/api/missions';

/**
 * How a Mission's status is PRESENTED in the picker — icon + badge tone,
 * the same square-chip language `WorkSelect` and `AgentSelect` use. A
 * Mission's status is the thing that decides whether a Task filed under
 * it will ever be picked up, so it rides along with every row.
 *
 * Tones are literal strings (never composed at runtime) so Tailwind's
 * class scanner can see them.
 */
const MISSION_STATUS_PRESENTATION: Record<MissionStatus, { icon: LucideIcon; tone: string }> = {
    active: {
        icon: Target,
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    paused: {
        icon: Pause,
        tone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    },
    completed: {
        icon: CheckCircle2,
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    },
    failed: {
        icon: TriangleAlert,
        tone: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    },
};

const NO_MISSION_ICON = 'none';

const MISSION_STATUS_ICONS: Record<string, React.ReactNode> = {
    [NO_MISSION_ICON]: (
        <CircleDashed className="size-3.5 text-text-muted dark:text-text-muted-dark" />
    ),
    ...Object.fromEntries(
        (Object.keys(MISSION_STATUS_PRESENTATION) as MissionStatus[]).map((status) => {
            const { icon: Icon, tone } = MISSION_STATUS_PRESENTATION[status];
            return [
                status,
                <span
                    key={status}
                    className={cn('grid size-4 shrink-0 place-items-center rounded-[3px]', tone)}
                >
                    <Icon className="size-2.5" />
                </span>,
            ];
        }),
    ),
};

interface MissionOption {
    id: string;
    title: string;
    status: MissionStatus | null;
}

export interface MissionSelectProps {
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly disabled?: boolean;
    readonly size?: 'xs' | 'sm' | 'default';
    readonly noneLabel: string;
    readonly placeholder?: string;
    readonly testId?: string;
    /** Lands on the trigger button so a `<label htmlFor>` can address it. */
    readonly id?: string;
}

/**
 * Mission picker for a Task's `missionId`.
 *
 * Task ownership is deliberately NON-exclusive on the API side
 * (`TASK_OWNER_KEYS` in `@ever-works/agent/tasks-domain`), so this sits
 * BESIDE the Work and Agent pickers rather than replacing them: a Task
 * raised by a Mission and belonging to a Work is one Task with two
 * associations, not two Tasks.
 *
 * Shaped after `WorkSelect` / `AgentSelect`: same load-once-on-mount
 * contract, same "unknown id stays selectable" fallback so a Mission the
 * list read missed never silently drops off the Task.
 */
export function MissionSelect({
    value,
    onValueChange,
    disabled = false,
    size = 'default',
    noneLabel,
    placeholder,
    testId,
    id,
}: MissionSelectProps) {
    const [missions, setMissions] = useState<MissionOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listMissionsAction();
                if (cancelled) return;
                setMissions(
                    rows.map((m) => ({
                        id: m.id,
                        title: m.title,
                        status: m.status ?? null,
                    })),
                );
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof Error ? err.message : 'Failed to load Missions.');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const options = useMemo(() => {
        if (!value || missions.some((m) => m.id === value)) return missions;
        return [{ id: value, title: `${value.slice(0, 8)}…`, status: null }, ...missions];
    }, [missions, value]);

    return (
        <div className="space-y-1">
            <Select
                id={id}
                value={value}
                onValueChange={onValueChange}
                disabled={disabled || loading}
                size={size}
                placeholder={placeholder}
                data-testid={testId}
                iconMap={MISSION_STATUS_ICONS}
            >
                <option value="" data-icon={NO_MISSION_ICON}>
                    {noneLabel}
                </option>
                {options.map((m) => (
                    <option key={m.id} value={m.id} data-icon={m.status ?? NO_MISSION_ICON}>
                        {m.title}
                    </option>
                ))}
            </Select>
            {loadError && (
                <p className="text-[11px] text-danger" role="alert">
                    {loadError}
                </p>
            )}
        </div>
    );
}
