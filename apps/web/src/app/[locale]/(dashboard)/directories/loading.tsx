export default function DirectoriesLoading() {
    return (
        <div className="animate-pulse">
            {/* Header skeleton */}
            <div className="flex justify-between items-center mb-6">
                <div className="h-7 w-36 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                <div className="h-10 w-36 bg-surface-secondary dark:bg-surface-secondary-dark rounded-lg" />
            </div>

            {/* Directory cards skeleton */}
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div
                        key={i}
                        className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-6"
                    >
                        <div className="flex items-start justify-between mb-3">
                            <div className="flex-1">
                                <div className="h-6 w-3/4 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-2" />
                                <div className="h-4 w-1/2 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                            </div>
                            <div className="h-6 w-16 bg-surface-secondary dark:bg-surface-secondary-dark rounded-full" />
                        </div>
                        <div className="h-4 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-2" />
                        <div className="h-4 w-5/6 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-4" />
                        <div className="flex gap-4 mb-4">
                            <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                            <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                        </div>
                        <div className="pt-4 border-t border-border dark:border-border-dark">
                            <div className="h-3 w-32 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
