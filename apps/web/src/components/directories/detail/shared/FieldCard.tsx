import type { ReactNode } from 'react';

export function FieldCard({
    label,
    helper,
    children,
}: {
    label: string;
    helper?: string;
    children: ReactNode;
}) {
    return (
        <div className="rounded-xl border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 space-y-3">
            <div>
                <p className="text-sm font-medium text-text dark:text-text-dark">{label}</p>
                {helper && (
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {helper}
                    </p>
                )}
            </div>
            {children}
        </div>
    );
}
