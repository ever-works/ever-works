export default function DirectoryDetailLoading() {
    return (
        <div className="animate-pulse">
            {/* Directory header skeleton */}
            <div className="mb-6">
                <div className="flex items-center gap-3 mb-4">
                    <div className="h-10 w-10 bg-surface-secondary dark:bg-surface-secondary-dark rounded-lg" />
                    <div>
                        <div className="h-7 w-56 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-1" />
                        <div className="h-4 w-80 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                    </div>
                </div>
                {/* Tab nav skeleton */}
                <div className="flex gap-4 border-b border-border dark:border-border-dark pb-2">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <div
                            key={i}
                            className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded"
                        />
                    ))}
                </div>
            </div>

            {/* Content area skeleton */}
            <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                    <div
                        key={i}
                        className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-6"
                    >
                        <div className="h-5 w-1/3 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-3" />
                        <div className="h-4 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-2" />
                        <div className="h-4 w-2/3 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                    </div>
                ))}
            </div>
        </div>
    );
}
