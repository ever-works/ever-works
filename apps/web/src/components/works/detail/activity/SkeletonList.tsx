import { cn } from '@/lib/utils/cn';

export function SkeletonList({ rows = 8 }: { rows?: number }) {
    return (
        <ul className="space-y-2" aria-busy="true" aria-hidden="true">
            {Array.from({ length: rows }).map((_, idx) => (
                <li
                    key={idx}
                    className={cn(
                        'flex items-center gap-3 rounded-md border p-3',
                        'border-border dark:border-border-dark',
                        'bg-card dark:bg-card-primary-dark/30',
                    )}
                >
                    <div className="h-8 w-8 rounded-full bg-muted dark:bg-muted/30 animate-pulse" />
                    <div className="flex-1 space-y-2">
                        <div className="h-3 w-2/3 rounded bg-muted dark:bg-muted/30 animate-pulse" />
                        <div className="h-2 w-1/4 rounded bg-muted dark:bg-muted/30 animate-pulse" />
                    </div>
                </li>
            ))}
        </ul>
    );
}
