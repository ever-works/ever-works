export default function SettingsLoading() {
    return (
        <div className="animate-pulse">
            {/* Settings header skeleton */}
            <div className="mb-8">
                <div className="h-8 w-32 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-2" />
                <div className="h-4 w-64 bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
            </div>

            {/* Settings sections skeleton */}
            <div className="space-y-6">
                {[1, 2, 3].map((i) => (
                    <div
                        key={i}
                        className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-6"
                    >
                        <div className="h-5 w-40 bg-surface-secondary dark:bg-surface-secondary-dark rounded mb-4" />
                        <div className="space-y-3">
                            <div className="h-10 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                            <div className="h-10 w-full bg-surface-secondary dark:bg-surface-secondary-dark rounded" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
