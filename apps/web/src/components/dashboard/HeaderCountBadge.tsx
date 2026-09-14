import { cn } from '@/lib/utils/cn';

interface HeaderCountBadgeProps {
    /** The count to show. Nothing renders for `null`, `undefined`, `0` or a negative value. */
    count: number | null | undefined;
    /** Above this, the badge reads `{max}+` instead of the number. */
    max: number;
    className?: string;
    /** Optional `data-testid` for the badge element. */
    testId?: string;
}

/**
 * The counted badge that sits on a dashboard top-bar control.
 *
 * One treatment for every counted control in the header — the notification
 * bell (`max` 99) and What's new (`max` 9, spec FR-24) — so the two read as
 * the same kind of signal. The markup is exactly what the bell rendered
 * inline before it was shared, so the bell looks and reads as it did.
 */
export function HeaderCountBadge({ count, max, className, testId }: HeaderCountBadgeProps) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
        return null;
    }
    return (
        <span
            data-testid={testId}
            className={cn(
                'absolute top-1 right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-danger rounded-full',
                className,
            )}
        >
            {count > max ? `${max}+` : count}
        </span>
    );
}
