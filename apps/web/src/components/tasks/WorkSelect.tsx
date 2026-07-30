'use client';

import { useEffect, useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { getWorks } from '@/app/actions/dashboard/works';
import { cn } from '@/lib/utils/cn';
import { normalizeWorkKind, WORK_KINDS, WORK_KIND_PRESENTATION } from '@/lib/work-kinds/catalog';

/** Matches the bulk Work read the Teams page already does. */
const WORK_PICKER_LIMIT = 100;

interface WorkOption {
    id: string;
    name: string;
    kind: string | null;
}

const NO_WORK_ICON = 'none';

const WORK_KIND_ICONS: Record<string, React.ReactNode> = {
    [NO_WORK_ICON]: <Inbox className="size-3.5 text-text-muted dark:text-text-muted-dark" />,
    ...Object.fromEntries(
        WORK_KINDS.map((kind) => {
            const { icon: Icon, tone } = WORK_KIND_PRESENTATION[kind];
            return [
                kind,
                <span
                    key={kind}
                    className={cn('grid size-4 shrink-0 place-items-center rounded-[3px]', tone)}
                >
                    <Icon className="size-2.5" />
                </span>,
            ];
        }),
    ),
};

export interface WorkSelectProps {
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

export function WorkSelect({
    value,
    onValueChange,
    disabled = false,
    size = 'default',
    noneLabel,
    placeholder,
    testId,
    id,
}: WorkSelectProps) {
    const [works, setWorks] = useState<WorkOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await getWorks({ limit: WORK_PICKER_LIMIT });
                if (cancelled) return;
                if (res.success) {
                    setWorks(
                        res.works.map((w) => ({
                            id: w.id,
                            name: w.name,
                            kind: w.kind ?? null,
                        })),
                    );
                } else {
                    setLoadError(res.error ?? 'Failed to load Works.');
                }
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof Error ? err.message : 'Failed to load Works.');
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
        if (!value || works.some((w) => w.id === value)) return works;
        return [{ id: value, name: `${value.slice(0, 8)}…`, kind: null }, ...works];
    }, [works, value]);

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
                iconMap={WORK_KIND_ICONS}
            >
                <option value="" data-icon={NO_WORK_ICON}>
                    {noneLabel}
                </option>
                {options.map((w) => (
                    <option key={w.id} value={w.id} data-icon={normalizeWorkKind(w.kind)}>
                        {w.name}
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
