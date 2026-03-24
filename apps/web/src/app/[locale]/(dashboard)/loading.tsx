export default function DashboardLoading() {
    return (
        <div className="p-6 lg:p-8 max-w-7xl mx-auto w-full animate-pulse">
            {/* Page header skeleton */}
            <div className="mb-8">
                <div className="h-8 w-48 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-2" />
                <div className="h-4 w-72 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
            </div>

            {/* Content cards skeleton */}
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div
                        key={i}
                        className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-6"
                    >
                        <div className="h-6 w-3/4 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-3" />
                        <div className="h-4 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-2" />
                        <div className="h-4 w-5/6 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-4" />
                        <div className="flex gap-4">
                            <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                            <div className="h-4 w-20 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
