'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export function CollapsibleSection({
    title,
    description,
    defaultExpanded = false,
    children,
}: {
    title: string;
    description?: string;
    defaultExpanded?: boolean;
    children: ReactNode;
}) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-surface dark:hover:bg-surface-dark transition-colors"
            >
                <div>
                    <h3 className="text-lg font-medium text-text dark:text-text-dark">{title}</h3>
                    {description && (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                            {description}
                        </p>
                    )}
                </div>
                <svg
                    className={cn(
                        'w-5 h-5 text-text-secondary dark:text-text-secondary-dark transition-transform',
                        isExpanded && 'rotate-180',
                    )}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                    />
                </svg>
            </button>
            {isExpanded && <div className="px-6 pb-4 pt-2">{children}</div>}
        </div>
    );
}
