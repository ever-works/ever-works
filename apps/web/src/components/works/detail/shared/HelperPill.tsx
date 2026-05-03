import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export function HelperPill({
    children,
    tone,
    icon: Icon,
}: {
    children: ReactNode;
    tone: 'success' | 'alert';
    icon: ComponentType<{ className?: string }>;
}) {
    return (
        <span
            className={cn(
                'mt-2 inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
                tone === 'success'
                    ? 'bg-success/10 text-success'
                    : 'bg-destructive/10 text-destructive',
            )}
        >
            <Icon className="h-4 w-4" aria-hidden />
            {children}
        </span>
    );
}
