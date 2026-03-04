'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface TooltipProps {
    content: string;
    children: ReactNode;
    position?: 'top' | 'bottom' | 'right' | 'left';
}

export function Tooltip({ content, children, position = 'top' }: TooltipProps) {
    return (
        <span className="group relative inline-flex">
            {children}
            <span
                className={cn(
                    'pointer-events-none absolute z-50',
                    'px-2.5 py-1.5 rounded-md text-xs leading-tight max-w-56 w-max text-center',
                    'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900',
                    'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
                    position === 'top' && 'bottom-full left-1/2 -translate-x-1/2 mb-2',
                    position === 'bottom' && 'top-full left-1/2 -translate-x-1/2 mt-2',
                    position === 'right' && 'left-full top-1/2 -translate-y-1/2 ml-2',
                    position === 'left' && 'right-full top-1/2 -translate-y-1/2 mr-2',
                )}
                role="tooltip"
            >
                {content}
            </span>
        </span>
    );
}
