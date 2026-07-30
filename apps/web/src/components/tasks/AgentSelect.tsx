'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, Archive, Bot, BotOff, Pause, PencilLine, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { listAgentOptionsAction } from '@/app/actions/agents';
import { cn } from '@/lib/utils/cn';
import type { AgentPickerOption, AgentStatus } from '@/lib/api/agents.shared';

/** Matches the bulk Agent read the Teams and Skills surfaces already do. */
const AGENT_PICKER_LIMIT = 100;

/**
 * How an Agent's status is PRESENTED in the picker — icon + badge tone,
 * the same square-chip language `WORK_KIND_PRESENTATION` gives the Work
 * dropdown. Status is the Agent equivalent of a Work's kind here: it is
 * the one thing that decides whether the Agent you pick will actually
 * pick the Task up, so it rides along with every row.
 *
 * Tones are literal strings (never composed at runtime) so Tailwind's
 * class scanner can see them.
 */
const AGENT_STATUS_PRESENTATION: Record<AgentStatus, { icon: LucideIcon; tone: string }> = {
    draft: {
        icon: PencilLine,
        tone: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
    },
    active: {
        icon: Bot,
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    paused: {
        icon: Pause,
        tone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    },
    running: {
        icon: Activity,
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    },
    error: {
        icon: TriangleAlert,
        tone: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    },
    archived: {
        icon: Archive,
        tone: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
    },
};

const NO_AGENT_ICON = 'none';

const AGENT_STATUS_ICONS: Record<string, React.ReactNode> = {
    [NO_AGENT_ICON]: <BotOff className="size-3.5 text-text-muted dark:text-text-muted-dark" />,
    ...Object.fromEntries(
        (Object.keys(AGENT_STATUS_PRESENTATION) as AgentStatus[]).map((status) => {
            const { icon: Icon, tone } = AGENT_STATUS_PRESENTATION[status];
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

export interface AgentSelectProps {
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
 * Agent picker for a Task's `agentId` — the assignment that makes "Run"
 * on Task detail dispatch straight away instead of stopping to ask which
 * Agent to use (run resolution is assignees → the Task's Agent → the
 * Work default).
 *
 * Shaped after `WorkSelect`: same load-once-on-mount contract, same
 * "unknown id stays selectable" fallback so an Agent outside the first
 * page (or one just archived) never silently drops off the Task.
 */
export function AgentSelect({
    value,
    onValueChange,
    disabled = false,
    size = 'default',
    noneLabel,
    placeholder,
    testId,
    id,
}: AgentSelectProps) {
    const [agents, setAgents] = useState<AgentPickerOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listAgentOptionsAction(AGENT_PICKER_LIMIT);
                if (!cancelled) setAgents(rows);
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof Error ? err.message : 'Failed to load Agents.');
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
        if (!value || agents.some((a) => a.id === value)) return agents;
        return [
            {
                id: value,
                name: `${value.slice(0, 8)}…`,
                slug: value,
                status: 'draft' as AgentStatus,
            },
            ...agents,
        ];
    }, [agents, value]);

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
                iconMap={AGENT_STATUS_ICONS}
            >
                <option value="" data-icon={NO_AGENT_ICON}>
                    {noneLabel}
                </option>
                {options.map((a) => (
                    <option key={a.id} value={a.id} data-icon={a.status}>
                        {a.name}
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
