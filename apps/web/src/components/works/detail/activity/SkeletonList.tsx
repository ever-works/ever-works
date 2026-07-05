export function SkeletonList({ rows = 8 }: { rows?: number }) {
    return (
        <div
            className="overflow-hidden rounded-lg border border-border dark:border-border-dark"
            aria-busy="true"
            aria-hidden="true"
        >
            <div className="bg-muted/50 dark:bg-muted/20 px-4 py-3.5">
                <div className="h-3 w-1/3 rounded bg-muted dark:bg-muted/30 animate-pulse" />
            </div>
            <ul className="divide-y divide-border dark:divide-border-dark">
                {Array.from({ length: rows }).map((_, idx) => (
                    <li
                        key={idx}
                        className="flex items-center gap-4 px-4 py-3 bg-card dark:bg-transparent"
                    >
                        <div className="h-3 w-24 shrink-0 rounded bg-muted dark:bg-muted/30 animate-pulse" />
                        <div className="h-4 w-20 shrink-0 rounded-full bg-muted dark:bg-muted/30 animate-pulse" />
                        <div className="h-3 flex-1 rounded bg-muted dark:bg-muted/30 animate-pulse" />
                        <div className="h-4 w-24 shrink-0 rounded-full bg-muted dark:bg-muted/30 animate-pulse" />
                    </li>
                ))}
            </ul>
        </div>
    );
}
