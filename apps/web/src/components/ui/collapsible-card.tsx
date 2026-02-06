'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface CollapsibleCardProps {
    /** Content rendered in the always-visible header area */
    header: React.ReactNode;
    /** Content rendered when expanded */
    children: React.ReactNode;
    /** Whether the card starts expanded */
    defaultExpanded?: boolean;
    /** Additional class for the outer container */
    className?: string;
    /** Additional class for the header button */
    headerClassName?: string;
    /** Additional class for the expanded body */
    bodyClassName?: string;
    /** Right-side actions rendered in the header (won't trigger toggle) */
    actions?: React.ReactNode;
}

export function CollapsibleCard({
    header,
    children,
    defaultExpanded = false,
    className,
    headerClassName,
    bodyClassName,
    actions,
}: CollapsibleCardProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    return (
        <div
            className={cn(
                'rounded-lg border border-border dark:border-border-dark transition-colors',
                className,
            )}
        >
            {/* Header */}
            <div className={cn('flex items-center gap-3', headerClassName)}>
                <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex-1 flex items-center gap-3 text-left min-w-0 py-4 pl-5 pr-2"
                >
                    <ChevronDown
                        className={cn(
                            'w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0 transition-transform duration-200',
                            !isExpanded && '-rotate-90',
                        )}
                    />
                    <div className="flex-1 min-w-0">{header}</div>
                </button>

                {actions && (
                    <div
                        className="shrink-0 pr-5 flex items-center gap-2"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {actions}
                    </div>
                )}
            </div>

            {/* Body */}
            {isExpanded && (
                <div
                    className={cn('border-t border-border dark:border-border-dark', bodyClassName)}
                >
                    {children}
                </div>
            )}
        </div>
    );
}
