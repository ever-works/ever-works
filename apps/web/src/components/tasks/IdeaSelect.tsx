'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, Hammer, Lightbulb, Timer, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { listProposalsAction } from '@/app/actions/dashboard/work-proposals';
import { cn } from '@/lib/utils/cn';
import type { WorkProposalStatus } from '@/lib/api/work-proposals';

/** Matches the bulk read the Work and Agent pickers already do. */
const IDEA_PICKER_LIMIT = 100;

/**
 * Statuses the picker offers. `dismissed` is deliberately absent: an Idea
 * the user has thrown away is not a filing target. A Task already filed
 * under a dismissed Idea keeps it anyway — the unknown-id fallback below
 * re-adds whatever `value` holds.
 */
const IDEA_PICKER_STATUSES: WorkProposalStatus[] = [
    'pending',
    'queued',
    'building',
    'accepted',
    'failed',
];

/**
 * How an Idea's status is PRESENTED in the picker — icon + badge tone, the
 * same square-chip language `WorkSelect` / `AgentSelect` / `MissionSelect`
 * use.
 *
 * Tones are literal strings (never composed at runtime) so Tailwind's
 * class scanner can see them.
 */
const IDEA_STATUS_PRESENTATION: Record<WorkProposalStatus, { icon: LucideIcon; tone: string }> = {
    pending: {
        icon: Lightbulb,
        tone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    },
    queued: {
        icon: Timer,
        tone: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
    },
    building: {
        icon: Hammer,
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    },
    accepted: {
        icon: CheckCircle2,
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    failed: {
        icon: TriangleAlert,
        tone: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    },
    dismissed: {
        icon: CircleDashed,
        tone: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
    },
};

const NO_IDEA_ICON = 'none';

const IDEA_STATUS_ICONS: Record<string, React.ReactNode> = {
    [NO_IDEA_ICON]: <CircleDashed className="size-3.5 text-text-muted dark:text-text-muted-dark" />,
    ...Object.fromEntries(
        (Object.keys(IDEA_STATUS_PRESENTATION) as WorkProposalStatus[]).map((status) => {
            const { icon: Icon, tone } = IDEA_STATUS_PRESENTATION[status];
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

interface IdeaOption {
    id: string;
    title: string;
    status: WorkProposalStatus | null;
}

export interface IdeaSelectProps {
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
 * Idea picker for a Task's `ideaId` (Ideas are `work_proposals` on the
 * wire — `workProposalsAPI`).
 *
 * Task ownership is non-exclusive on the API side, so this sits beside
 * the Work, Mission and Agent pickers: filing a Task under an Idea says
 * "this Task exists because of that Idea" and does not detach anything
 * else.
 *
 * Shaped after `WorkSelect` / `AgentSelect`: same load-once-on-mount
 * contract, same "unknown id stays selectable" fallback so an Idea
 * outside the fetched page (or a dismissed one) never silently drops off
 * the Task.
 */
export function IdeaSelect({
    value,
    onValueChange,
    disabled = false,
    size = 'default',
    noneLabel,
    placeholder,
    testId,
    id,
}: IdeaSelectProps) {
    const [ideas, setIdeas] = useState<IdeaOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listProposalsAction(IDEA_PICKER_STATUSES, {
                    limit: IDEA_PICKER_LIMIT,
                });
                if (cancelled) return;
                setIdeas(
                    rows.map((idea) => ({
                        id: idea.id,
                        title: idea.title,
                        status: idea.status ?? null,
                    })),
                );
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof Error ? err.message : 'Failed to load Ideas.');
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
        if (!value || ideas.some((i) => i.id === value)) return ideas;
        return [{ id: value, title: `${value.slice(0, 8)}…`, status: null }, ...ideas];
    }, [ideas, value]);

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
                iconMap={IDEA_STATUS_ICONS}
            >
                <option value="" data-icon={NO_IDEA_ICON}>
                    {noneLabel}
                </option>
                {options.map((idea) => (
                    <option key={idea.id} value={idea.id} data-icon={idea.status ?? NO_IDEA_ICON}>
                        {idea.title}
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
